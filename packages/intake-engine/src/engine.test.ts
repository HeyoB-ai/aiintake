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
        anker: {
          iso: '2026-08-22',
          weekdag: 'zaterdag',
          weekdagIndex: 6,
          tijd: '12:00',
          timeZone: 'Europe/Amsterdam',
        },
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
  /**
   * De regel met de uitgeschreven opening, los van de toelichting eronder.
   *
   * De instructie noemt dezelfde zinsdelen twee keer: één keer als voorbeeld en één keer
   * als uitleg waarom het zo moet. Een test die de hele tekst doorzoekt, kan de uitleg
   * voor het voorbeeld aanzien.
   */
  function voorbeeldzin(body: string): string {
    const regel = body.split('\n').find((r) => r.includes('Ik ben de AI-intake-assistent van'));
    if (!regel) throw new Error('geen uitgeschreven opening in de instructie gevonden');
    return regel;
  }

  async function openingsPrompt(orgNaam = 'Kantoor De Vries', now?: Date) {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(
      invoer({
        organization: { id: 'o', name: orgNaam, slug: 's' } as OrgConfig,
        ...(now ? { now } : {}),
      }),
    );
    return model.laatsteSysteem;
  }

  it('eist dat het woord AI letterlijk valt', async () => {
    // "intake-assistent" kan een cliënt horen als een medewerker die de intake doet. De
    // spec eist dat er staat dát het een AI is, en dat is iets anders dan de mededeling
    // dat het geen advocaat is.
    const body = await openingsPrompt();
    expect(body).toContain('AI-intake-assistent');
    expect(body).toContain('Het woord "AI" moet er letterlijk in staan');
    expect(body).toContain('twee verschillende mededelingen');
  });

  it('eist dat de assistent zegt geen advocaat te zijn en geen advies te geven', async () => {
    const body = await openingsPrompt();
    expect(body).toContain('Ik ben geen advocaat');
    expect(body).toContain('geen juridisch advies');
    expect(body).toContain('afgezwakt');
  });

  it('noemt wat ze doet en waarom, in die volgorde', async () => {
    const body = await openingsPrompt();
    const wat = body.indexOf('de gegevens van uw zaak vast te leggen');
    const waarom = body.indexOf('sneller kan beoordelen');
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
    // Vier zinnen in totaal. Met drie sneuvelt er een van de vier mededelingen, meestal
    // uitgerekend "ik ben geen advocaat".
    expect(body).toContain('Maximaal 4 zinnen');
  });

  it('zet een zinseinde na de kantoornaam en geen komma met "en"', async () => {
    // Gesproken plakt ", en" twee mededelingen aan elkaar die elk op zichzelf moeten
    // landen; de luisteraar verliest dan de eerste helft.
    const body = await openingsPrompt();
    expect(body).toContain('Ik ben de AI-intake-assistent van Kantoor De Vries. Ik ben geen');
    expect(body).toContain('volgt een punt');
    expect(body).not.toContain('van Kantoor De Vries, en ik ben geen advocaat');
  });

  it('noemt de taak vóór de beperking, in de voorbeeldzin zelf', async () => {
    /*
     * Alleen binnen de voorbeeldzin kijken, en niet in de hele instructie.
     *
     * Een eerdere versie zocht de twee fragmenten in de volledige tekst. Die test bleef
     * groen toen de voorbeeldzin de beperking naar voren haalde — want "Zelf geef ik geen
     * juridisch advies" staat óók in de toelichting eronder, en die staat sowieso later.
     * Hij bewees dus de volgorde van de uitleg in plaats van die van de zin.
     */
    const body = await openingsPrompt();
    const voorbeeld = voorbeeldzin(body);
    const taak = voorbeeld.indexOf('aangesteld om de gegevens van uw zaak vast te leggen');
    const beperking = voorbeeld.indexOf('Zelf geef ik geen juridisch advies');
    expect(taak).toBeGreaterThan(-1);
    expect(beperking).toBeGreaterThan(taak);
  });

  it('schrijft losse korte zinnen voor, omdat dit wordt uitgesproken', async () => {
    const body = await openingsPrompt();
    expect(body).toContain('uitgesproken, niet gelezen');
    expect(body).toContain('een adem te lang');
  });

  it('kiest de groet op het tijdstip en laat dat niet aan het model', async () => {
    // De engine heeft `now`; een model heeft geen klok en zei "Goedemorgen" om acht uur
    // 's avonds. De grenzen zelf staan in packages/prompts/src/groet.test.ts.
    const ochtend = await openingsPrompt('Kantoor De Vries', new Date('2026-08-22T07:00:00Z'));
    const avond = await openingsPrompt('Kantoor De Vries', new Date('2026-08-22T19:00:00Z'));
    expect(ochtend).toContain('Goedemorgen.');
    expect(avond).toContain('Goedenavond.');
    expect(avond).not.toContain('Goedemorgen');
    expect(avond).toContain('Het tijdstip is bekend; kies er zelf geen andere');
  });

  it('staat op versie 8 of hoger, zodat llm_calls de opening kan onderscheiden', () => {
    expect(PROMPTS.conversation.version).toBeGreaterThanOrEqual(8);
  });
});

describe('de gespreksvorm', () => {
  /**
   * Drie regels die het gesprek van een verhoor onderscheiden, en die tot nu toe alleen in
   * de prompttekst stonden.
   *
   * De openingsbeurt had al tests; deze drie niet. Dat is een verschil zonder reden: een
   * regel die nergens door wordt vastgehouden, verdwijnt bij de eerstvolgende herformulering
   * van de prompt zonder dat iemand het merkt. Ze staan op de instructie en niet op de
   * uitvoer, om dezelfde reden als hierboven: wat het model ervan maakt verschilt per
   * beurt, de opdracht hoort er onvoorwaardelijk in te staan.
   */

  /** Een gesprek van `beurten` cliëntbeurten, zodat de narratieve fase te sturen is. */
  function verloop(beurten: number): EngineInput['history'] {
    return Array.from({ length: beurten * 2 }, (_, i) => ({
      id: `t${i}`,
      role: i % 2 === 0 ? ('assistant' as const) : ('client' as const),
      content: i % 2 === 0 ? 'vraag' : 'antwoord',
      plannedQuestionKeys: [],
      createdAt: '2026-08-22T09:00:00Z',
    }));
  }

  async function promptNa(beurten: number) {
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(
      invoer({ history: verloop(beurten), lastClientUtterance: 'ik ben ontslagen' }),
    );
    return model.laatsteSysteem;
  }

  it('laat de cliënt na de openingsvraag uitpraten', async () => {
    // De opening nodigt uit tot vertellen; er meteen een tweede vraag achteraan plakken
    // maakt die uitnodiging ongedaan.
    const model = hot(['x']);
    const engine = createIntakeEngine({ hot: model, cold: cold(['{"facts":[]}']) });
    await engine.respond(invoer());
    expect(model.laatsteSysteem).toContain('Na de vraag laat u het aan de cliënt');
    expect(model.laatsteSysteem).toContain('Geen tweede vraag');
  });

  it('oogst in de eerste beurten uit het verhaal in plaats van af te vinken', async () => {
    const body = await promptNa(1);
    expect(body).toContain('Oogst uit dat verhaal; ga niet afvinken');
    // De kandidatenlijst is er wel, maar uitdrukkelijk als geheugensteun.
    expect(body).toContain('géén vragenlijst maar een geheugensteun');
    expect(body).toContain('hooguit één na');
  });

  it('staat toe helemaal geen vraag te stellen zolang het verhaal loopt', async () => {
    // Zonder deze uitweg stelt het model altijd een vraag, ook midden in een verhaal.
    const body = await promptNa(2);
    expect(body).toContain('stel dan helemaal geen nieuwe vraag');
    expect(body).toContain('nodig uit om verder te vertellen');
  });

  it('gaat na de narratieve fase over op gerichte vragen', async () => {
    // Drie cliëntbeurten is de grens; daarna mag de planner sturen. Blijft de engine
    // eindeloos oogsten, dan komen de must-haves nooit binnen.
    const body = await promptNa(5);
    expect(body).not.toContain('Oogst uit dat verhaal');
    expect(body).toContain('Kies één van deze onderwerpen');
  });

  it('vraagt open waar het kan en bewaart gesloten vragen voor één ontbrekend detail', async () => {
    const body = await promptNa(1);
    expect(body).toContain('Stel open vragen waar dat kan');
    expect(body).toContain('Kunt u vertellen hoe dat is gegaan?');
    expect(body).toContain(
      'Gesloten vragen bewaar je voor het aanvullen van één ontbrekend detail',
    );
  });

  it('verbiedt vulwoorden als erkenning — liever niets dan nep', async () => {
    const body = await promptNa(1);
    expect(body).toContain('Geen vulwoorden als erkenning');
    expect(body).toContain('Liever niets dan nep');
    // De uitweg hoort erbij: iets specifieks erkennen mag, met de woorden van de cliënt.
    expect(body).toContain('met de woorden van de cliënt');
  });

  it('geeft de narratieve fase een zin meer ruimte dan een gerichte vraag', async () => {
    // Een uitnodiging om te vertellen kost een zin meer dan een gesloten vraag; met twee
    // zinnen wordt de uitnodiging weer een vraag.
    expect(await promptNa(1)).toContain('Maximaal 3 zinnen');
    expect(await promptNa(5)).toContain('Maximaal 2 zinnen');
  });
});

describe('het weekdag-vangnet', () => {
  /**
   * Gemeten: het model rekent offsets goed uit maar weekdagnamen niet. "Afgelopen vrijdag"
   * en "vorige week maandag" leverden allebei 2026-08-18 op, tegen een anker van zaterdag
   * 22 augustus 2026 — dat is een dinsdag, en twee keer dezelfde fout is geen toeval.
   *
   * De rekenregels zelf staan in packages/domain/src/weekdag.test.ts. Hier gaat het om de
   * vraag of de engine ze toepast, en of hij dat níét doet waar dat niet hoort.
   */
  const ANKER_NU = new Date('2026-08-22T10:00:00Z'); // zaterdag, 12:00 in Amsterdam

  function datumFeitJson(waarde: string, citaat: string): string {
    return JSON.stringify({
      facts: [
        {
          key: 'summary_dismissal_date',
          value: waarde,
          status: 'confirmed',
          confidence: 0.9,
          evidenceQuote: citaat,
        },
      ],
    });
  }

  async function observeer(modelWaarde: string, uitspraak: string) {
    const correcties: { key: string; van: unknown; naar: string; uitspraak: string }[] = [];
    const engine = createIntakeEngine({
      hot: hot([]),
      cold: cold([datumFeitJson(modelWaarde, uitspraak)]),
      onWeekdayCorrection: (c) => correcties.push(c),
    });
    const r = await engine.observe(
      invoer({
        now: ANKER_NU,
        facts: { termination_route: feit('termination_route', 'summary_dismissal') },
        lastClientUtterance: uitspraak,
      }),
    );
    return { r, correcties };
  }

  it('zet een verkeerd berekende weekdag recht', async () => {
    const { r, correcties } = await observeer(
      '2026-08-18',
      'Ik ben afgelopen vrijdag op staande voet ontslagen.',
    );
    expect(r.factUpdates.find((f) => f.key === 'summary_dismissal_date')?.value).toBe('2026-08-21');
    // En de correctie is zichtbaar; stil rechtzetten is niet te onderscheiden van een
    // controle die niets doet.
    expect(correcties).toHaveLength(1);
    expect(correcties[0]).toMatchObject({ van: '2026-08-18', naar: '2026-08-21' });
  });

  it('laat een datum met rust als het model hem goed had', async () => {
    const { r, correcties } = await observeer(
      '2026-08-21',
      'Ik ben afgelopen vrijdag op staande voet ontslagen.',
    );
    expect(r.factUpdates[0]?.value).toBe('2026-08-21');
    expect(correcties).toHaveLength(0);
  });

  it('bemoeit zich niet met een uitspraak zonder weekdag', async () => {
    // Offsets gaan goed; er een tweede berekening naast zetten zou betekenen dat twee
    // stukken code het oneens kunnen worden over dezelfde zin.
    const { r, correcties } = await observeer(
      '2026-06-22',
      'Ik ben twee maanden geleden ontslagen.',
    );
    expect(r.factUpdates[0]?.value).toBe('2026-06-22');
    expect(correcties).toHaveLength(0);
  });

  it('laat een expliciete datum met een weekdagnaam erbij ongemoeid', async () => {
    // "vrijdag 21 augustus" hoeft niet uitgerekend te worden. Een vangnet dat gaat
    // overschrijven wat al klopt, is zelf een risico.
    const { correcties } = await observeer('2026-08-21', 'Dat was vrijdag 21 augustus.');
    expect(correcties).toHaveLength(0);
  });
});
