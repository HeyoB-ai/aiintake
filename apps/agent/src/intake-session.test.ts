import { describe, expect, it } from 'vitest';
import type { CaseFact, OrgConfig } from '@intake/domain';
import type { LLMProvider, TextRequest } from '@intake/provider-llm';
import { IntakeSession } from './intake-session';

/**
 * De lege-inhoudbug, vastgelegd.
 *
 * Live kwam dit naar boven als `messages.0: user messages must have non-empty content`.
 * De openingsbeurt legde een leeg cliëntbericht in de geschiedenis, en vanaf dat moment
 * liep élke volgende beurt stuk — niet de beurt waarin het ontstond. Zulke fouten
 * verplaatsen zich, en daarom staat de controle hier op de inhoud van de berichtenlijst
 * en niet op "gaat het goed".
 */

const ORG = { id: 'org-1', name: 'Kantoor De Vries', slug: 'devries' } as OrgConfig;

function vangLlm(): LLMProvider & { verzoeken: TextRequest[] } {
  const p = {
    id: 'vang',
    verzoeken: [] as TextRequest[],
    streamText(request: TextRequest) {
      p.verzoeken.push(request);
      return (async function* () {
        yield 'ok';
      })();
    },
    async generateStructured() {
      throw new Error('niet gebruikt');
    },
    lastUsage: () => ({ inputTokens: null, outputTokens: null, latencyMs: null }),
  };
  return p as unknown as LLMProvider & { verzoeken: TextRequest[] };
}

/**
 * Het laatste *gespreks*verzoek, niet het laatste verzoek.
 *
 * Sinds de erkenningslaag gaan er twee soorten aanroepen over dezelfde provider: de
 * gespreksbeurt en het ladingoordeel. `verzoeken.at(-1)` was daarmee niet langer wat deze
 * tests bedoelden — hij kon het ladingverzoek teruggeven, en dan gaan de assertions over
 * de verkeerde prompt.
 *
 * Selecteren op de inhoud van de systeemprompt en niet op volgorde: de volgorde is een
 * race en die hoort geen testuitkomst te bepalen.
 */
function laatsteGesprek(llm: { verzoeken: TextRequest[] }): TextRequest {
  const gesprek = llm.verzoeken.filter((r) => !r.system.includes('"lading"'));
  const laatste = gesprek.at(-1);
  if (!laatste) throw new Error('geen gespreksverzoek gevangen');
  return laatste;
}

function sessie(llm: LLMProvider) {
  return new IntakeSession({
    llm,
    organization: ORG,
    hotModel: 'test-hot',
    coldModel: 'test-cold',
    now: () => new Date('2026-08-22T10:00:00Z'),
  });
}

async function leeg(bron: ReturnType<IntakeSession['responseSource']>, utterance: string) {
  const c = new AbortController();
  for await (const _ of bron({ utterance }, c.signal)) {
    /* leeglezen */
  }
}

describe('IntakeSession — geen lege berichten naar het model', () => {
  it('legt de lege cliëntbeurt van de opening niet in de geschiedenis vast', async () => {
    const llm = vangLlm();
    const s = sessie(llm);

    // Zo verloopt de opening: de assistent praat, de cliënt zei niets.
    s.recordTurn('', 'Hallo, waar gaat het om?');
    await leeg(s.responseSource(), 'Ik heb een vaststellingsovereenkomst gekregen.');

    const berichten = laatsteGesprek(llm).messages;
    expect(berichten.length).toBeGreaterThan(0);
    for (const m of berichten) expect(m.content.trim().length).toBeGreaterThan(0);
    // De begroeting hoort er wél in te staan; alleen de lege cliëntbeurt niet.
    expect(berichten.some((m) => m.content.includes('waar gaat het om'))).toBe(true);
  });

  it('filtert een leeg bericht ook als het toch in de geschiedenis zou staan', async () => {
    const llm = vangLlm();
    const s = sessie(llm);
    // Tweede zeef: ook als er langs een andere weg iets leegs binnenkomt.
    s.recordTurn('   ', '   ');
    s.recordTurn('Ik werk bij Acme.', 'Sinds wanneer?');
    await leeg(s.responseSource(), 'Sinds 2019.');

    for (const m of laatsteGesprek(llm).messages) {
      expect(m.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('doet voor de openingsbeurt helemaal geen modelaanroep', async () => {
    /*
     * Hier stond: "geeft de openingsbeurt een aanleiding in plaats van een lege lijst". Die
     * test bewaakte dat het model bij de opening een niet-lege gebruikersboodschap kreeg,
     * want een lege berichtenlijst wordt door de API geweigerd met
     * `messages.0: user messages must have non-empty content`.
     *
     * Sinds de opening een vaste zin is, kan die fout daar niet meer ontstaan: er gaat geen
     * verzoek uit. Dat is een sterkere garantie dan de oude, en dit is de meting ervan.
     *
     * De oude garantie blijft nodig voor de hervatting — ook een beurt zonder cliëntuitspraak,
     * en die gáát wél langs het model. Dat pad staat elders in deze suite.
     */
    const llm = vangLlm();
    const s = sessie(llm);
    await leeg(s.responseSource(), '');

    const gesprek = llm.verzoeken.filter((r) => !r.system.includes('"lading"'));
    expect(gesprek).toHaveLength(0);
  });
});

/**
 * Het onderwerp gaat mee naar het dossier.
 *
 * Niet "de regel rekent goed" — dat staat in `packages/domain/src/onderwerp.test.ts`. Hier gaat
 * het om de vraag die eerder twee keer verkeerd is beantwoord: **komt de waarde ook echt aan?**
 * Een afleiding die klopt en nergens landt, ziet er van buiten precies zo uit als een kolom
 * zonder bron — en dat wás risico 24.
 *
 * `observe()` zonder nieuwe beurten doet geen modelaanroep (zie engine.observe), dus dit draait
 * zonder LLM en zonder netwerk.
 */
describe('IntakeSession — het onderwerp bereikt updateProgress', () => {
  function feit(value: unknown): CaseFact {
    return {
      key: 'x',
      value,
      valueType: typeof value === 'boolean' ? 'boolean' : 'enum',
      status: 'confirmed',
      confidence: 0.9,
      source: 'client_statement',
      sourceRef: 'msg-1',
      llmCallId: null,
    };
  }

  function metFeiten(facts: Record<string, CaseFact>) {
    const voortgang: { completeness?: number | null; subject?: string | null }[] = [];
    const meldingen: string[] = [];
    const sessie = new IntakeSession({
      onVastlegging: (m) => meldingen.push(m.sleutel),
      llm: vangLlm(),
      organization: ORG,
      hotModel: 'test-hot',
      coldModel: 'test-cold',
      now: () => new Date('2026-08-28T10:00:00Z'),
      initialFacts: facts,
      rpc: {
        appendMessage: async () => undefined,
        upsertFact: async () => undefined,
        updateProgress: async (args: { completeness?: number | null; subject?: string | null }) => {
          voortgang.push(args);
          return undefined;
        },
      } as unknown as NonNullable<ConstructorParameters<typeof IntakeSession>[0]['rpc']>,
    });
    return { sessie, voortgang, meldingen };
  }

  it('stuurt het afgeleide onderwerp mee', async () => {
    // De feiten van het gesprek van 27 augustus, 19:05.
    const { sessie, voortgang } = metFeiten({
      primary_issue: feit('dismissal'),
      termination_route: feit('summary_dismissal'),
    });

    await sessie.observe();

    expect(voortgang).toHaveLength(1);
    expect(voortgang[0]!.subject).toBe('Ontslag op staande voet');
  });

  it('stuurt null zolang er niets af te leiden valt', async () => {
    /*
     * Leeg blijft leeg. De RPC doet `coalesce(p_subject, subject)`, dus een null overschrijft
     * nooit een gevuld onderwerp — maar hij vult de kolom ook niet met een gok.
     */
    const { sessie, voortgang } = metFeiten({});

    await sessie.observe();

    expect(voortgang).toHaveLength(1);
    expect(voortgang[0]!.subject).toBeNull();
  });

  it('meldt waaróp het onderwerp rust', async () => {
    // Zonder de bronnen is achteraf niet te zien waaruit het volgde, en dan is een verouderd
    // onderwerp niet te herkennen.
    const { sessie, voortgang, meldingen } = metFeiten({
      termination_route: feit('summary_dismissal'),
      currently_ill: feit(true),
    });

    await sessie.observe();

    expect(voortgang[0]!.subject).toBe('Ontslag op staande voet, tijdens ziekte');
    expect(meldingen.some((m) => m.includes('termination_route, currently_ill'))).toBe(true);
  });
});
