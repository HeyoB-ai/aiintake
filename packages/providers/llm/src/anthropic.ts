import type { LLMProvider, LlmUsage, StructuredRequest, TextRequest } from './contract';
import { readSse, textFromSse, type StreamTotals } from './sse';
import type { Validated } from '@intake/domain';

/**
 * De Anthropic-provider, met `fetch` en zonder SDK.
 *
 * Twee redenen. De SDK zou een vendorafhankelijkheid toevoegen aan een pakket dat juist
 * bestaat om die te isoleren, en het hot path is één SSE-stream die we per fragment
 * moeten doorgeven — daar is geen abstractie voor nodig, wel controle over wanneer het
 * eerste token doorkomt.
 *
 * Het onderscheid tussen de twee methodes is het hele ontwerp. `streamText` blokkeert
 * spraak en levert daarom platte tekst zodra die er is, zonder validatie en zonder
 * retry. `generateStructured` blokkeert niets en mag daarom wél repareren.
 */

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export interface AnthropicOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Maximaal aantal reparatiepogingen op het koude pad. */
  readonly maxRepairAttempts?: number;
}

export class AnthropicLlmProvider implements LLMProvider {
  readonly id = 'anthropic';
  private usage: LlmUsage = { inputTokens: null, outputTokens: null, latencyMs: null };

  constructor(private readonly options: AnthropicOptions) {
    if (!options.apiKey) throw new Error('AnthropicLlmProvider: apiKey ontbreekt');
  }

  /**
   * Hot path.
   *
   * Geen `await response.json()`: dat wacht op het hele antwoord en dan is de eerste
   * mondbeweging drie seconden te laat. We lezen de SSE-stream en geven elk tekstdeel
   * door zodra het binnenkomt.
   */
  async *streamText(request: TextRequest): AsyncIterable<string> {
    const gestart = Date.now();

    const response = await fetch(this.options.baseUrl ?? API, {
      method: 'POST',
      headers: this.headers(),
      signal: request.signal ?? null,
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 300,
        stream: true,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Anthropic: HTTP ${response.status} — ${detail.slice(0, 300)}`);
    }

    const totals: StreamTotals = { inputTokens: null, outputTokens: null, firstTokenAt: null };
    try {
      yield* textFromSse(readSse(response.body), totals);
    } finally {
      // `latencyMs` is hier bewust de tijd tot het EERSTE token en niet tot het laatste.
      // Dat is het getal uit de latencybegroting: TTFT bepaalt wanneer de mond beweegt,
      // de totale duur bepaalt alleen hoe lang de zin is.
      this.usage = {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        latencyMs: totals.firstTokenAt === null ? null : totals.firstTokenAt - gestart,
      };
    }
  }

  /**
   * Cold path, met reparatie.
   *
   * De reparatiepoging krijgt de vorige uitvoer én de validatiefout mee. Blind opnieuw
   * vragen levert meestal dezelfde fout op; een model dat zijn eigen schemafout ziet,
   * herstelt hem meestal wel.
   */
  async generateStructured<T>(request: StructuredRequest<T>): Promise<Validated<T>> {
    const maxPogingen = (request.maxRepairAttempts ?? this.options.maxRepairAttempts ?? 1) + 1;
    const gestart = Date.now();
    let laatsteRuw = '';
    let laatsteFout = '';

    for (let poging = 0; poging < maxPogingen; poging += 1) {
      const input =
        poging === 0
          ? request.input
          : `${request.input}\n\nJe vorige antwoord was ongeldig:\n${laatsteRuw.slice(0, 2000)}\n\nFout: ${laatsteFout}\n\nGeef opnieuw antwoord, nu volgens het schema.`;

      const response = await fetch(this.options.baseUrl ?? API, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: request.model,
          max_tokens: 4096,
          system: request.system,
          messages: [{ role: 'user', content: input }],
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Anthropic: HTTP ${response.status} — ${detail.slice(0, 300)}`);
      }

      const body = (await response.json()) as AnthropicMessage;
      this.usage = {
        inputTokens: body.usage?.input_tokens ?? null,
        outputTokens: body.usage?.output_tokens ?? null,
        latencyMs: Date.now() - gestart,
      };

      laatsteRuw = (body.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');

      const geparsed = parseJson(laatsteRuw);
      if (!geparsed.ok) {
        laatsteFout = geparsed.error;
        continue;
      }
      const gevalideerd = request.schema.safeParse(geparsed.value);
      if (gevalideerd.success) {
        return {
          data: request.schema.parse(geparsed.value),
          schemaValid: true,
          repairAttempts: poging,
          raw: laatsteRuw,
        };
      }
      laatsteFout = 'komt niet overeen met het schema';
    }

    throw new Error(`Anthropic: schema niet gehaald na ${maxPogingen} pogingen — ${laatsteFout}`);
  }

  lastUsage(): LlmUsage {
    return this.usage;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.options.apiKey,
      'anthropic-version': VERSION,
      'content-type': 'application/json',
    };
  }
}

/** Modellen zetten er soms een codeblok omheen, ook als je erom vraagt het te laten. */
function parseJson(tekst: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const schoon = tekst
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return { ok: true, value: JSON.parse(schoon) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'ongeldige JSON' };
  }
}

interface AnthropicMessage {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}
