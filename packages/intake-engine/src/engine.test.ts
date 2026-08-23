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

describe('rekenkundige beweringen van de cliënt', () => {
  /**
   * Het vangnet achter de prompt.
   *
   * De prompt vraagt het model om een zelf uitgerekende uitkomst niet als feit vast te
   * leggen. Deze tests controleren wat er gebeurt als het dat tóch doet — want een
   * instructie is een verzoek en dit is een regel. Live landde 140.000 als
   * `vso_severance_offered` met status `confirmed` en confidence 0,85, met een keurig
   * citaat eronder.
   */
  const utterance = 'Ze bieden twaalf maandsalarissen. 12 x 12000 is 140000.';

  /** Het citaat moet letterlijk in het transcript staan, anders weigert de verankering. */
  function antwoord(value: number, citaat: string) {
    return JSON.stringify({
      facts: [
        {
          key: 'vso_severance_offered',
          value,
          status: 'confirmed',
          confidence: 0.85,
          evidenceQuote: citaat,
        },
      ],
    });
  }

  it('degradeert een foute uitkomst naar unknown, met het citaat', async () => {
    const engine = createIntakeEngine({
      hot: hot([]),
      cold: cold([antwoord(140000, '12 x 12000 is 140000')]),
    });
    const r = await engine.observe(invoer({ lastClientUtterance: utterance }));

    const feit = r.factUpdates.find((f) => f.key === 'vso_severance_offered');
    expect(feit).toBeDefined();
    expect(feit!.status).toBe('unknown');
    expect(feit!.value).toBeNull();
    expect(feit!.confidence).toBe(0);
    // Het citaat blijft staan: de advocaat moet kunnen zien wat er gezegd is.
    expect(feit!.evidenceQuote).toContain('140000');
  });

  it('laat een kloppende som staan, maar niet als confirmed', async () => {
    // 144.000 klopt wél. Het blijft een afleiding van de cliënt en geen waarneming, dus
    // hooguit `inferred` — anders staat er een bedrag in het dossier dat niemand zo heeft
    // genoemd, alleen zo heeft uitgerekend.
    const goed = 'Twaalf maandsalarissen. 12 x 12000 is 144000.';
    const engine = createIntakeEngine({
      hot: hot([]),
      cold: cold([antwoord(144000, '12 x 12000 is 144000')]),
    });
    const r = await engine.observe(invoer({ lastClientUtterance: goed }));

    const feit = r.factUpdates.find((f) => f.key === 'vso_severance_offered');
    expect(feit!.status).toBe('inferred');
    expect(feit!.value).toBe(144000);
    expect(feit!.confidence).toBeLessThanOrEqual(0.6);
  });

  it('waarschuwt het hot path zodat het terugvraagt in plaats van bevestigt', async () => {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(invoer({ lastClientUtterance: utterance }));

    expect(model.laatsteSysteem).toContain('rekenfout');
    expect(model.laatsteSysteem).toContain('144.000');
    expect(model.laatsteSysteem).toContain('bevestig');
  });

  it('waarschuwt niet als de som klopt', async () => {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(invoer({ lastClientUtterance: '12 x 12000 is 144000.' }));
    expect(model.laatsteSysteem).not.toContain('rekenfout');
  });
});

describe('de assistent mag geen bron van zichzelf zijn', () => {
  /**
   * Live vroeg de assistent "was dat 17 januari?" — een datum die de cliënt nooit had
   * genoemd — en de cliënt zei "ja". De extractie legde 17 januari vast als `confirmed`,
   * met als citaat de eigen vraag van de assistent. De verankering keek naar het hele
   * transcript en vond die zin daar netjes terug.
   *
   * Dezelfde familie als de 140.000 uit risico 9: iets wordt als vaststaand gepresenteerd
   * dat het systeem niet weet. Alleen verzon hier niet de cliënt het maar het model zelf,
   * en dat is erger — de cliënt kan zijn eigen fout nog corrigeren.
   *
   * Deze tests draaien met een vast modelantwoord en niet tegen het echte model: of het
   * model het déze keer probeert is variatie, of het systeem het accepteert is de regel.
   */
  const geschiedenis = [
    {
      id: 't1',
      role: 'client' as const,
      content: 'Ik ben op staande voet ontslagen.',
      plannedQuestionKeys: [],
      createdAt: '2026-08-22T09:00:00Z',
    },
    {
      id: 't2',
      role: 'assistant' as const,
      content: 'Wat vervelend. Wanneer was dat — was dat 17 januari?',
      plannedQuestionKeys: [],
      createdAt: '2026-08-22T09:00:01Z',
    },
  ];

  function datumFeit(citaat: string) {
    return JSON.stringify({
      facts: [
        {
          key: 'summary_dismissal_date',
          value: '2026-01-17',
          status: 'confirmed',
          confidence: 0.8,
          evidenceQuote: citaat,
        },
      ],
    });
  }

  it('weigert een citaat uit de eigen vraag van de assistent', async () => {
    const engine = createIntakeEngine({
      hot: hot([]),
      cold: cold([datumFeit('was dat 17 januari?')]),
    });
    const r = await engine.observe(invoer({ history: geschiedenis, lastClientUtterance: 'Ja.' }));

    expect(r.factUpdates.find((f) => f.key === 'summary_dismissal_date')).toBeUndefined();
    // De reden moet uitleggen wát er mis was. "Komt niet voor in de bron" zou hier
    // misleiden: het model citeerde netjes, alleen zichzelf.
    expect(r.rejectedFacts?.[0]?.reason).toContain('assistent-beurt');
  });

  it('weigert een instemming zonder inhoud als bron voor een concrete waarde', async () => {
    // "Ja." komt wél letterlijk van de cliënt. Maar een instemming draagt geen datum;
    // hij bevestigt hooguit iets wat een ander heeft gezegd. Zonder deze regel is de
    // reparatie hierboven te omzeilen door simpelweg het antwoord te citeren.
    const engine = createIntakeEngine({
      hot: hot([]),
      cold: cold([datumFeit('Ja.')]),
    });
    const r = await engine.observe(invoer({ history: geschiedenis, lastClientUtterance: 'Ja.' }));

    expect(r.factUpdates.find((f) => f.key === 'summary_dismissal_date')).toBeUndefined();
    expect(r.rejectedFacts?.[0]?.reason).toBeDefined();
  });

  it('laat een datum die de cliënt zelf noemde gewoon door', async () => {
    const engine = createIntakeEngine({
      hot: hot([]),
      cold: cold([datumFeit('op 17 januari ben ik ontslagen')]),
    });
    const r = await engine.observe(
      invoer({ lastClientUtterance: 'op 17 januari ben ik ontslagen' }),
    );
    expect(r.factUpdates.find((f) => f.key === 'summary_dismissal_date')?.value).toBe('2026-01-17');
  });
});

describe('de openingsbeurt', () => {
  /**
   * De opening is de enige beurt met een harde inhoudseis: er moet in staan dat dit geen
   * advocaat is en dat er geen advies wordt gegeven. Dat is geen stijlkwestie maar de
   * verwachting waarop iemand de rest van het gesprek beoordeelt — en het is precies het
   * punt dat sneuvelt als het model zich beperkt tot een korte introductie.
   *
   * Deze tests staan op de instructie en niet op de uitvoer: wat het model ervan maakt is
   * per beurt anders, maar de opdracht hoort er onvoorwaardelijk in te staan.
   */
  async function openingsPrompt(orgNaam = 'Kantoor De Vries') {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(
      invoer({ organization: { id: 'o', name: orgNaam, slug: 's' } as OrgConfig }),
    );
    return model.laatsteSysteem;
  }

  it('eist dat de assistent zegt geen advocaat te zijn en geen advies te geven', async () => {
    const body = await openingsPrompt();
    expect(body).toContain('géén advocaat');
    expect(body).toContain('geen juridisch advies');
    expect(body).toContain('niet worden afgezwakt');
  });

  it('noemt wat ze doet en waarom, in die volgorde', async () => {
    const body = await openingsPrompt();
    const wat = body.indexOf('vastleggen en ordenen');
    const waarom = body.indexOf('sneller en beter');
    const vraag = body.indexOf('Kunt u vertellen wat er speelt');
    expect(wat).toBeGreaterThan(-1);
    expect(waarom).toBeGreaterThan(wat);
    expect(vraag).toBeGreaterThan(waarom);
  });

  it('verbiedt uitspraken over kosten', async () => {
    // Het systeem doet geen financiële toezeggingen namens het kantoor. "Efficiënter voor
    // de beoordeling" is iets anders dan "dit beperkt uw kosten".
    const body = await openingsPrompt();
    expect(body).toContain('Geen uitspraken over');
    expect(body).toContain('die toezegging is niet aan u');
  });

  it('haalt de kantoornaam uit de organisatieconfiguratie', async () => {
    const body = await openingsPrompt('Advocatenkantoor Jansen & Partners');
    expect(body).toContain('Advocatenkantoor Jansen & Partners');
    expect(body).not.toContain('Kantoor De Vries');
  });

  it('houdt de opening kort genoeg om uit te luisteren', async () => {
    const body = await openingsPrompt();
    expect(body).toContain('twee tot drie zinnen');
    // Vier zinnen in totaal: drie voor wie/wat/waarom, één voor de vraag. Met drie
    // sneuvelt er een van de vier punten, meestal uitgerekend "ik ben geen advocaat".
    expect(body).toContain('Maximaal 4 zinnen');
  });

  it('staat op versie 5 of hoger, zodat llm_calls de opening kan onderscheiden', () => {
    expect(PROMPTS.conversation.version).toBeGreaterThanOrEqual(5);
  });
});
