import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_RULES,
  EMPLOYMENT_TEMPLATE,
  type CaseFact,
  type OrgConfig,
} from '@intake/domain';
import { PROMPTS } from '@intake/prompts';
import { createIntakeEngine, type ColdPathModel, type HotPathModel } from './engine';
import type { EngineInput } from './types';

/**
 * De engine, zonder één netwerkcall.
 *
 * Dat dit kan, ís de architectuur: input is toestand, output is een beslissing. Zou hier
 * een HTTP-client of een avatar-SDK bij nodig zijn, dan was de intake-intelligentie niet
 * langer identiek in videomodus en chat-fallback — en dan was de hele
 * providerdiscussie ineens ook een productdiscussie.
 */

const NU = new Date('2026-08-22T10:00:00Z');

function hot(chunks: string[]): HotPathModel & { laatsteSysteem: string } {
  const model = {
    laatsteSysteem: '',
    stream(req: { system: string }) {
      model.laatsteSysteem = req.system;
      return (async function* () {
        for (const c of chunks) yield c;
      })();
    },
  };
  return model;
}

function cold(antwoorden: string[]): ColdPathModel & { aanroepen: number } {
  const model = {
    aanroepen: 0,
    async complete(): Promise<string> {
      const antwoord = antwoorden[model.aanroepen] ?? antwoorden[antwoorden.length - 1] ?? '{}';
      model.aanroepen += 1;
      return antwoord;
    },
  };
  return model;
}

function invoer(over: Partial<EngineInput> = {}): EngineInput {
  return {
    organization: { id: 'org-1', name: 'Kantoor De Vries', slug: 'devries' } as OrgConfig,
    practiceArea: 'employment',
    template: EMPLOYMENT_TEMPLATE,
    rules: EMPLOYMENT_RULES,
    facts: {},
    history: [],
    documents: [],
    pendingLawyerRequests: [],
    language: 'nl',
    mode: 'realtime',
    now: NU,
    ...over,
  } as EngineInput;
}

function feit(key: string, value: unknown): CaseFact {
  return {
    key,
    value,
    valueType: 'string',
    status: 'confirmed',
    confidence: 0.9,
    source: 'client_statement',
    sourceRef: 'turn-1',
    llmCallId: null,
    updatedAt: '2026-08-22T09:00:00Z',
  };
}

describe('IntakeConversationEngine — hot path', () => {
  it('streamt platte tekst en geen JSON', async () => {
    const model = hot(['Goedemiddag. ', 'Waar gaat het om?']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });

    const beslissing = await engine.respond(invoer());
    let tekst = '';
    for await (const stuk of beslissing.speak) tekst += stuk;

    expect(tekst).toBe('Goedemiddag. Waar gaat het om?');
    // Je kunt geen half-afgemaakt JSON-veld uitspreken; dat is de reden dat het hot path
    // platte tekst levert en alle structuur op het koude pad zit.
    expect(() => JSON.parse(tekst)).toThrow();
  });

  it('geeft de openingsbeurt geen kandidatenlijst mee', async () => {
    // De opening is een open vraag. Zou de planner hier zijn kandidaten inbrengen, dan
    // begint het gesprek met een gesloten vraag over de ontslagroute in plaats van met
    // "waar gaat het om".
    const model = hot(['hoi']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(invoer());

    expect(model.laatsteSysteem).toContain('Dit is de opening');
    expect(model.laatsteSysteem).not.toContain('Kies één van deze onderwerpen');
  });

  it('vertelt het model wat er al bekend is, zodat het niet dubbel vraagt', async () => {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(
      invoer({
        facts: { employer_name: feit('employer_name', 'Acme BV') },
        history: [
          {
            id: 't1',
            role: 'client',
            content: 'hallo',
            plannedQuestionKeys: [],
            createdAt: '2026-08-22T09:00:00Z',
          },
        ],
        lastClientUtterance: 'ja',
      }),
    );
    expect(model.laatsteSysteem).toContain('Acme BV');
    expect(model.laatsteSysteem).toContain('Vraag er niet opnieuw naar');
  });

  it('geeft bij een barge-in alleen het gehoorde deel door', async () => {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(
      invoer({ lastClientUtterance: 'nee wacht', interruptedPrefix: 'Wanneer heeft u' }),
    );
    expect(model.laatsteSysteem).toContain('Wanneer heeft u');
    expect(model.laatsteSysteem).toContain('Herhaal je vorige zin niet woordelijk');
  });

  it('laat de instructie het geven van juridisch advies verbieden', async () => {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(invoer());
    // Dit is geen stijlvoorschrift maar de productgrens uit de architectuur: het systeem
    // verzamelt en signaleert, het adviseert niet.
    expect(model.laatsteSysteem).toContain('geen juridisch advies');
  });
});

describe('IntakeConversationEngine — cold path', () => {
  /**
   * De vorm die het model moet leveren is bewust kleiner dan wat we opslaan.
   *
   * `valueType`, `source` en `sourceRef` vult de engine zelf: die staan in de catalogus of
   * zijn per definitie bekend. Ze tóch aan het model vragen kostte live vier beurten —
   * het model leverde de feiten correct maar noemde ze `field` en `quote`, het strikte
   * schema wees alles af, en de engine gooide dat stil weg.
   */
  it('accepteert een feit met een citaat dat in het transcript staat', async () => {
    const antwoord = JSON.stringify({
      facts: [
        {
          key: 'employer_name',
          value: 'Acme BV',
          status: 'confirmed',
          confidence: 0.9,
          evidenceQuote: 'Ik werk bij Acme BV',
        },
      ],
    });
    const engine = createIntakeEngine({ hot: hot([]), cold: cold([antwoord]) });
    const r = await engine.observe(
      invoer({ lastClientUtterance: 'Ik werk bij Acme BV sinds maart.' }),
    );
    expect(r.factUpdates.map((f) => f.key)).toContain('employer_name');
  });

  it('weigert een feit waarvan het citaat niet in het transcript voorkomt', async () => {
    // De hallucinatiecheck. Een verzonnen salaris ziet er hetzelfde uit als een echt en
    // belandt zonder deze zeef met bronverwijzing en al in de samenvatting.
    const antwoord = JSON.stringify({
      facts: [
        {
          key: 'gross_monthly_salary',
          value: 4200,
          status: 'confirmed',
          confidence: 0.95,
          evidenceQuote: 'ik verdien 4200 euro bruto per maand',
        },
      ],
    });
    const engine = createIntakeEngine({ hot: hot([]), cold: cold([antwoord]) });
    const r = await engine.observe(
      invoer({ lastClientUtterance: 'Ik werk bij Acme BV sinds maart.' }),
    );
    expect(r.factUpdates).toHaveLength(0);
    expect(r.rejectedFacts?.[0]?.key).toBe('gross_monthly_salary');
  });

  it('probeert het opnieuw na ongeldige JSON en slaagt dan alsnog', async () => {
    const goed = JSON.stringify({
      facts: [
        {
          key: 'employer_name',
          value: 'Acme BV',
          status: 'confirmed',
          confidence: 0.9,
          evidenceQuote: 'Ik werk bij Acme BV',
        },
      ],
    });
    const model = cold(['dit is geen json', goed]);
    const engine = createIntakeEngine({ hot: hot([]), cold: model });
    const r = await engine.observe(
      invoer({ lastClientUtterance: 'Ik werk bij Acme BV sinds maart.' }),
    );
    expect(model.aanroepen).toBe(2);
    expect(r.factUpdates).toHaveLength(1);
  });

  it('gooit het gesprek niet om als het model twee keer faalt', async () => {
    const model = cold(['rommel', 'nog steeds rommel']);
    const engine = createIntakeEngine({ hot: hot([]), cold: model });
    const r = await engine.observe(invoer({ lastClientUtterance: 'iets' }));
    expect(r.factUpdates).toHaveLength(0);
    // Score en regels komen er wél, want die hangen niet van het model af. Een mislukte
    // extractie kost één beurt feitenkennis; een exception zou de intake kosten.
    expect(typeof r.completeness).toBe('number');
  });

  it('roept het model niet aan als er niets nieuws is gezegd', async () => {
    const model = cold(['{"facts":[]}']);
    const engine = createIntakeEngine({ hot: hot([]), cold: model });
    const r = await engine.observe(invoer());
    expect(model.aanroepen).toBe(0);
    // De regels worden wél opnieuw gerekend: een deadline die vannacht dichterbij kwam,
    // moet vanochtend zichtbaar zijn zonder dat de cliënt eerst iets hoeft te zeggen.
    expect(r.riskFlags).toBeDefined();
  });

  it('meldt een urgentieregel zonder dat het model eraan te pas komt', async () => {
    const engine = createIntakeEngine({ hot: hot([]), cold: cold(['{"facts":[]}']) });
    const r = await engine.observe(
      invoer({ facts: { vso_signing_deadline: feit('vso_signing_deadline', '2026-08-25') } }),
    );
    expect(r.riskFlags.map((f) => f.ruleKey)).toContain('vso_deadline_imminent');
    expect(r.riskFlags[0]?.level).toBe('CRITICAL');
  });
});

describe('extractieprompt', () => {
  it('beschrijft de veldnamen die het schema eist', () => {
    // Dit is de test die de live-bug had gevangen. De prompt zei "antwoord volgens het
    // opgegeven schema" terwijl dat schema er nergens in stond; het model gokte `field`
    // en `quote`. Een prompt die naar een schema verwijst zonder het te tonen, is geen
    // instructie maar een aanname over wat het model toevallig kiest.
    const body = PROMPTS.extraction.render(
      {
        transcript: 'Cliënt: Ik werk bij Acme.',
        wantedFacts: [{ key: 'employer_name', label: 'Werkgever', valueType: 'string' }],
        knownFacts: [],
        todayIso: '2026-08-22',
      },
      'nl',
    );

    for (const veld of ['key', 'value', 'status', 'confidence', 'evidenceQuote']) {
      expect(body).toContain(veld);
    }
    // En de mechanische velden juist níét: die vraagt hij niet aan het model.
    expect(body).not.toContain('valueType"');
    expect(body).not.toContain('sourceRef');
  });

  it('staat op een hogere versie dan de kapotte v1', () => {
    // De versie gaat mee in llm_calls. Zonder ophogen is achteraf niet te zien welke
    // beurten met de prompt zonder schema zijn gedraaid.
    expect(PROMPTS.extraction.version).toBeGreaterThanOrEqual(2);
  });
});
