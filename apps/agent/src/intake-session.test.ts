import { describe, expect, it } from 'vitest';
import type { OrgConfig } from '@intake/domain';
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

  it('geeft de openingsbeurt een aanleiding in plaats van een lege lijst', async () => {
    const llm = vangLlm();
    const s = sessie(llm);
    await leeg(s.responseSource(), '');

    const berichten = laatsteGesprek(llm).messages;
    expect(berichten).toHaveLength(1);
    expect(berichten[0]!.role).toBe('user');
    expect(berichten[0]!.content.trim().length).toBeGreaterThan(0);
  });
});
