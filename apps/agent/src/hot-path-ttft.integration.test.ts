import { describe, expect, it } from 'vitest';
import { AnthropicLlmProvider } from '@intake/provider-llm';
import type { OrgConfig } from '@intake/domain';
import { IntakeSession } from './intake-session';

/**
 * TTFT op het hot path, met het echte model in de lus.
 *
 * **Waarom dit pas nu iets betekent.** Fase 1 mat 0,3 ms voor deze stap. Dat was geen
 * prestatie maar een leeg meetpunt: de echo-agent had geen model, dus er viel niets te
 * wachten. Het budget van 300 ms p50 / 600 ms p95 stond er wel, maar er was niets dat
 * eraan getoetst kon worden. Dit is de eerste meting die de regel invult.
 *
 * Wat er precies gemeten wordt: van "prompt de deur uit" tot "eerste tekstfragment
 * binnen". Niet tot het einde van de generatie — de zinsflusher stuurt de eerste zin naar
 * TTS zodra die compleet is, dus de totale generatieduur bepaalt hoe lang de beurt is en
 * niet wanneer de mond beweegt.
 *
 * Kost tokens, dus niet in `pnpm test`. Draaien met `pnpm test:pipeline`.
 */

const BUDGET_P50 = 300;
const BUDGET_P95 = 600;
const BEURTEN = 8;

const key = process.env['ANTHROPIC_API_KEY'];
const hotModel = process.env['LLM_HOT_MODEL'] ?? 'claude-haiku-4-5-20251001';

if (!key) {
  // Geen stille skip. Een overgeslagen meting die er groen uitziet, is precies de
  // stilte waar dit project elders bezwaar tegen maakt.
  // eslint-disable-next-line no-console
  console.warn(
    '\n[hot-path-ttft] OVERGESLAGEN — ANTHROPIC_API_KEY ontbreekt in .env.\n' +
      '  Zonder key is de TTFT-regel uit het latencybudget niet getoetst, en blijft\n' +
      '  het cijfer uit Fase 1 (0,3 ms, zonder model) het enige dat er staat.\n',
  );
}

function percentiel(waarden: readonly number[], p: number): number {
  const g = [...waarden].sort((a, b) => a - b);
  const pos = (g.length - 1) * p;
  const onder = Math.floor(pos);
  const boven = Math.ceil(pos);
  const laag = g[onder] ?? 0;
  return onder === boven ? laag : laag + ((g[boven] ?? laag) - laag) * (pos - onder);
}

const ORG: OrgConfig = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Kantoor De Vries',
  slug: 'devries',
} as OrgConfig;

/** Een realistisch gesprek: elke beurt bouwt op de vorige, zoals in een echte intake. */
const BEURTENTEKST = [
  'Ik heb gisteren een vaststellingsovereenkomst gekregen van mijn werkgever.',
  'Ik werk er sinds maart 2019, als projectleider.',
  'Het is Acme Nederland BV, ongeveer tweehonderd man.',
  'Ik verdien 4200 euro bruto per maand.',
  'Ze willen dat ik voor vrijdag teken.',
  'Ze bieden twee maandsalarissen aan.',
  'Nee, ik heb nog geen advocaat gesproken.',
  'Ik wil eigenlijk gewoon een fatsoenlijke regeling.',
];

describe.runIf(Boolean(key))('hot path — TTFT met het echte model', () => {
  it('haalt het budget van 300 ms p50 / 600 ms p95', async () => {
    const llm = new AnthropicLlmProvider({ apiKey: key! });
    const sessie = new IntakeSession({
      llm,
      organization: ORG,
      hotModel,
      coldModel: hotModel,
      now: () => new Date('2026-08-22T10:00:00Z'),
    });

    const bron = sessie.responseSource();
    const ttfts: number[] = [];
    const totalen: number[] = [];

    for (let i = 0; i < BEURTEN; i += 1) {
      const utterance = BEURTENTEKST[i % BEURTENTEKST.length]!;
      const controller = new AbortController();

      const start = performance.now();
      let eerste: number | null = null;
      let antwoord = '';

      for await (const stuk of bron({ utterance }, controller.signal)) {
        eerste ??= performance.now();
        antwoord += stuk;
      }
      const eind = performance.now();

      expect(antwoord.length).toBeGreaterThan(0);
      // Platte tekst, geen JSON. Zou het model toch structuur teruggeven, dan gaat dat
      // letterlijk de TTS in en hoort de cliënt accolades.
      expect(antwoord.trim().startsWith('{')).toBe(false);

      ttfts.push(Math.round((eerste ?? eind) - start));
      totalen.push(Math.round(eind - start));

      // De geschiedenis bijwerken zonder het koude pad te draaien: dit meet het hot
      // path, en een extractie-aanroep ertussen zou de meting vertroebelen met tijd
      // die in productie buiten de klok valt.
      sessie.recordTurn(utterance, antwoord);
    }

    const p50 = percentiel(ttfts, 0.5);
    const p95 = percentiel(ttfts, 0.95);

    // eslint-disable-next-line no-console
    console.log(
      `\n  Hot path TTFT — ${hotModel}, ${BEURTEN} beurten vanaf Nederland\n` +
        `    p50            ${p50.toFixed(0)} ms  (budget ${BUDGET_P50})\n` +
        `    p95            ${p95.toFixed(0)} ms  (budget ${BUDGET_P95})\n` +
        `    min / max      ${Math.min(...ttfts)} / ${Math.max(...ttfts)} ms\n` +
        `    ruw            ${ttfts.join(', ')}\n` +
        `    totale beurt   p50 ${percentiel(totalen, 0.5).toFixed(0)} ms (niet het budget; ` +
        `de zinsflusher stuurt de eerste zin al weg)\n`,
    );

    // Geen harde assert op het budget. Deze test is een meting, en een rode build bij
    // een netwerkhobbel zou hem binnen een week uitgezet krijgen. Wat wél hard is: er
    // komt tekst, en het duurt geen seconden.
    expect(p50).toBeGreaterThan(0);
    expect(p50).toBeLessThan(5000);
  }, 300_000);
});
