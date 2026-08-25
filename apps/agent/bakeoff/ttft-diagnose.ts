/**
 * Meten we modellatency of onze eigen opstelling?
 *
 * 594 ms TTFT voor Haiku op een korte prompt is hoog. Deze diagnose knipt de beurt in
 * fasen, zodat zichtbaar wordt waar de tijd blijft:
 *
 *   t0 → t1  fetch resolvet: DNS, TCP, TLS, verzenden, en wachten op de response-headers
 *   t1 → t2  eerste byte van de body binnen
 *   t2 → t3  eerste tekst-delta eruit gehaald
 *
 * Blijft t0→t1 hoog bij elke aanroep, dan zetten we per beurt een nieuwe verbinding op.
 * Daalt hij na de eerste, dan werkt connectiehergebruik en meten we het model.
 *
 * Daarnaast twee prompts: die van ons (lang systeemprompt) en een minimale. Het verschil
 * daartussen is wat de promptlengte kost, en dat is precies wat prompt caching moet
 * wegnemen.
 *
 * Draaien met: pnpm diag:ttft
 */

import { PROMPTS, practiceAreaLabel, render } from '@intake/prompts';

const API = 'https://api.anthropic.com/v1/messages';
const KEY = process.env['ANTHROPIC_API_KEY'];
const MODEL = process.env['LLM_HOT_MODEL'] ?? 'claude-haiku-4-5-20251001';
const RONDES = 6;

if (!KEY) {
  console.error('ANTHROPIC_API_KEY ontbreekt.');
  process.exit(1);
}

interface Fasen {
  headersMs: number;
  eersteByteMs: number;
  eersteTekstMs: number;
  /** Hoeveel SSE-gebeurtenissen er vóór de eerste tekst-delta langskwamen. */
  eventsVoorTekst: number;
  inputTokens: number | null;
  cacheGelezen: number | null;
  cacheGeschreven: number | null;
}

async function meet(system: unknown, user: string, cache: boolean): Promise<Fasen> {
  const t0 = performance.now();

  const response = await fetch(API, {
    method: 'POST',
    headers: {
      'x-api-key': KEY!,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      stream: true,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const t1 = performance.now();

  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} — ${(await response.text()).slice(0, 300)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let t2: number | null = null;
  let t3: number | null = null;
  let events = 0;
  let inputTokens: number | null = null;
  let cacheGelezen: number | null = null;
  let cacheGeschreven: number | null = null;

  lezen: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    t2 ??= performance.now();
    buffer += decoder.decode(value, { stream: true });

    const blokken = buffer.split('\n\n');
    buffer = blokken.pop() ?? '';
    for (const blok of blokken) {
      for (const regel of blok.split('\n')) {
        if (!regel.startsWith('data:')) continue;
        const payload = regel.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event: {
          type?: string;
          delta?: { type?: string; text?: string };
          message?: {
            usage?: {
              input_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
          };
        };
        try {
          event = JSON.parse(payload);
        } catch {
          continue;
        }
        if (event.type === 'message_start' && event.message?.usage) {
          inputTokens = event.message.usage.input_tokens ?? null;
          cacheGelezen = event.message.usage.cache_read_input_tokens ?? null;
          cacheGeschreven = event.message.usage.cache_creation_input_tokens ?? null;
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          t3 = performance.now();
          break lezen;
        }
        events += 1;
      }
    }
  }

  await reader.cancel().catch(() => undefined);
  void cache;

  return {
    headersMs: Math.round(t1 - t0),
    eersteByteMs: Math.round((t2 ?? t1) - t0),
    eersteTekstMs: Math.round((t3 ?? t2 ?? t1) - t0),
    eventsVoorTekst: events,
    inputTokens,
    cacheGelezen,
    cacheGeschreven,
  };
}

/** Ons echte systeemprompt, zodat de vergelijking over de werkelijke lengte gaat. */
function onsSysteem(): string {
  return render(
    PROMPTS.conversation,
    {
      organisationName: 'Kantoor De Vries',
      practiceAreaLabel: practiceAreaLabel('nl'),
      candidates: [
        { factKey: 'employment_start_date', label: 'Startdatum', hint: 'Sinds wanneer?' },
        { factKey: 'gross_monthly_salary', label: 'Bruto maandsalaris', hint: 'Hoeveel?' },
        { factKey: 'employer_name', label: 'Werkgever', hint: 'Welk bedrijf?' },
      ],
      knownFacts: [
        { label: 'Aanleiding', value: 'ontslag' },
        { label: 'Ontslagroute', value: 'vaststellingsovereenkomst' },
        { label: 'Contractvorm', value: 'onbepaalde tijd' },
      ],
      maxSentences: 2,
      allowFiller: false,
      isOpening: false,
      isClosing: false,
      narrativePhase: false,
      // Vast, zodat de promptlengte tussen runs niet verandert; dit meet latency.
      greeting: 'Goedemiddag',
    },
    'nl',
  ).body;
}

function tabel(naam: string, rijen: Fasen[]): void {
  console.log(`\n  ${naam}`);
  console.log(
    `    ${'#'.padEnd(4)}${'headers'.padEnd(10)}${'1e byte'.padEnd(10)}${'1e tekst'.padEnd(11)}` +
      `${'events'.padEnd(8)}${'in'.padEnd(7)}${'cache r/w'}`,
  );
  for (const [i, r] of rijen.entries()) {
    console.log(
      `    ${String(i + 1).padEnd(4)}${(r.headersMs + ' ms').padEnd(10)}` +
        `${(r.eersteByteMs + ' ms').padEnd(10)}${(r.eersteTekstMs + ' ms').padEnd(11)}` +
        `${String(r.eventsVoorTekst).padEnd(8)}${String(r.inputTokens ?? '—').padEnd(7)}` +
        `${r.cacheGelezen ?? 0} / ${r.cacheGeschreven ?? 0}`,
    );
  }
  const tekst = rijen.map((r) => r.eersteTekstMs).sort((a, b) => a - b);
  const headers = rijen.map((r) => r.headersMs).sort((a, b) => a - b);
  console.log(
    `    mediaan: headers ${headers[Math.floor(headers.length / 2)]} ms, ` +
      `1e tekst ${tekst[Math.floor(tekst.length / 2)]} ms`,
  );
}

/**
 * Nulmeting: een endpoint zónder inferentie.
 *
 * `GET /v1/models` doet geen model draaien. Wat hier staat is dus netwerk plus
 * API-overhead, en het verschil met een minimale `POST /v1/messages` is wat het starten
 * van de inferentie kost. Zonder deze meting weet je niet of je Amsterdam-Virginia meet
 * of een wachtrij.
 */
async function meetBasislijn(): Promise<number> {
  const t0 = performance.now();
  const r = await fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': KEY!, 'anthropic-version': '2023-06-01' },
  });
  await r.arrayBuffer();
  return Math.round(performance.now() - t0);
}

const basis: number[] = [];
for (let i = 0; i < RONDES; i += 1) basis.push(await meetBasislijn());
basis.sort((a, b) => a - b);
console.log(
  `
  netwerk + API zonder inferentie (GET /v1/models)
` +
    `    ruw      ${basis.join(', ')} ms
` +
    `    mediaan  ${basis[Math.floor(basis.length / 2)]} ms`,
);

const system = onsSysteem();
console.log(`model ${MODEL} · systeemprompt ${system.length} tekens`);

// 1. Ons prompt, zonder caching. Dit is wat de meting van 594 ms deed.
const zonder: Fasen[] = [];
for (let i = 0; i < RONDES; i += 1) {
  zonder.push(await meet(system, 'Ik werk er sinds maart 2019.', false));
}
tabel('ons systeemprompt, geen caching', zonder);

// 2. Minimaal prompt. Het verschil met (1) is wat de promptlengte kost.
const minimaal: Fasen[] = [];
for (let i = 0; i < RONDES; i += 1) {
  minimaal.push(await meet('Je bent beknopt.', 'Zeg hallo.', false));
}
tabel('minimaal systeemprompt (ondergrens van de opstelling)', minimaal);

// 3. Ons prompt mét cache_control. De eerste ronde schrijft de cache, de rest leest hem.
const gecached: Fasen[] = [];
for (let i = 0; i < RONDES; i += 1) {
  gecached.push(
    await meet(
      [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      'Ik werk er sinds maart 2019.',
      true,
    ),
  );
}
tabel('ons systeemprompt, mét prompt caching', gecached);

/**
 * Werkt prompt caching überhaupt, en helpt het?
 *
 * Hierboven bleef `cache r/w` op 0/0 staan. Anthropic hanteert een minimumlengte voor een
 * cachebaar blok; ons systeemprompt van ~519 tokens haalt die niet. Deze ronde plakt er
 * ballast bij tot ruim boven die grens, puur om te zien of het mechanisme aanslaat en wat
 * het dan met de TTFT doet. Het is géén representatief prompt — het is het antwoord op de
 * vraag of caching voor ons een hefboom kán zijn.
 */
const ballast = 'Achtergrondinformatie over het Nederlandse arbeidsrecht. '.repeat(400);
const groot = [
  {
    type: 'text',
    text: `${system}

${ballast}`,
    cache_control: { type: 'ephemeral' },
  },
];
const gecachedGroot: Fasen[] = [];
for (let i = 0; i < 4; i += 1) {
  gecachedGroot.push(await meet(groot, 'Ik werk er sinds maart 2019.', true));
}
tabel('groot prompt (>2048 tokens) mét caching — werkt het mechanisme?', gecachedGroot);

process.exit(0);
