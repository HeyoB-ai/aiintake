import type { Validated } from '@intake/domain';

/**
 * Twee sporen, en het onderscheid is geen stijlkeuze.
 *
 * `streamText` is het hot path: het blokkeert spraak, dus het levert platte tekst die
 * per zin naar TTS kan. Je kunt geen JSON naar TTS streamen — wachten op een compleet
 * object betekent 1,5 tot 3 seconden dood gezicht per beurt.
 *
 * `generateStructured` is het cold path: gesloten schema's, retry-met-repair bij
 * invalide JSON, en kwaliteit boven snelheid. Het blokkeert niets.
 */

export interface TextRequest {
  readonly system: string;
  readonly messages: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly model: string;
  readonly maxTokens?: number;
  /** Aborteren bij barge-in. De stream moet daar onmiddellijk op stoppen. */
  readonly signal?: AbortSignal;
}

export interface StructuredRequest<T> {
  readonly system: string;
  readonly input: string;
  readonly model: string;
  /** Gesloten schema. Wat er niet in past, wordt niet geaccepteerd. */
  readonly schema: { parse(value: unknown): T; safeParse(value: unknown): { success: boolean } };
  readonly maxRepairAttempts?: number;
}

export interface LlmUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly latencyMs: number | null;
}

export interface LLMProvider {
  readonly id: string;
  /** Hot path. Levert tekstfragmenten zodra ze beschikbaar zijn. */
  streamText(request: TextRequest): AsyncIterable<string>;
  /** Cold path. Valideert en repareert; gooit pas als reparatie niet lukt. */
  generateStructured<T>(request: StructuredRequest<T>): Promise<Validated<T>>;
  /** Verbruik van de laatste aanroep, voor llm_calls. */
  lastUsage(): LlmUsage;
}
