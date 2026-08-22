import type { Validated } from '@intake/domain';
import type { LLMProvider, LlmUsage, StructuredRequest, TextRequest } from './contract';

/**
 * Een LLM dat precies zegt wat de test wil, in stukjes.
 *
 * De opdeling in fragmenten is geen detail: de zinsflusher moet ook werken als een
 * zinseinde midden in een fragment valt, of als een fragment meerdere zinnen bevat.
 * Echte modellen leveren precies zulke grillige stukken.
 */
export class FakeLlmProvider implements LLMProvider {
  readonly id = 'fake';

  /** Wat er bij de volgende streamText wordt uitgeleverd, in volgorde. */
  script: string[] = [];
  /** Aantal fragmenten dat is uitgeleverd voordat er werd geaborteerd. */
  deliveredChunks = 0;
  aborted = false;
  lastRequest: TextRequest | null = null;

  private usage: LlmUsage = { inputTokens: null, outputTokens: null, latencyMs: null };

  constructor(script: string[] = []) {
    this.script = script;
  }

  async *streamText(request: TextRequest): AsyncIterable<string> {
    this.lastRequest = request;
    this.deliveredChunks = 0;
    this.aborted = false;

    for (const chunk of this.script) {
      if (request.signal?.aborted) {
        this.aborted = true;
        return;
      }
      this.deliveredChunks += 1;
      yield chunk;
    }

    this.usage = {
      inputTokens: 100,
      outputTokens: this.script.join('').length,
      latencyMs: 0,
    };
  }

  /** Wat generateStructured teruggeeft; per aanroep in te stellen door de test. */
  structuredResult: unknown = null;

  async generateStructured<T>(request: StructuredRequest<T>): Promise<Validated<T>> {
    const parsed = request.schema.safeParse(this.structuredResult);
    return {
      data: this.structuredResult as T,
      schemaValid: parsed.success,
      repairAttempts: 0,
    };
  }

  lastUsage(): LlmUsage {
    return this.usage;
  }
}

/**
 * De echo-agent van Fase 1: herhaalt wat de cliënt zei.
 *
 * Geen intelligentie, en dat is precies de bedoeling. Fase 1 meet of de lus werkt —
 * spraak in, gezicht dat praat, onderbreekbaar, binnen het latencybudget. Zou daar een
 * echt model in zitten, dan weet je bij een tegenvallende meting niet of het aan het
 * transport ligt of aan de generatie.
 */
export function echoResponse(utterance: string): string[] {
  return [`U zei: ${utterance}`, ' Klopt dat?'];
}
