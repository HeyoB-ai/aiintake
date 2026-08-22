import type { TextToSpeechProvider, TtsEvents, TtsOptions, TtsStream } from './contract';

/**
 * Synthese zonder leverancier, met een voorspelbare relatie tussen tekst en tijd.
 *
 * Elke zin levert audio op alsof hij met een vaste snelheid wordt uitgesproken. Dat is
 * geen benadering van echte spraak, maar het maakt de barge-in-test exact: onderbreken
 * na 400 ms betekent dan een precies te berekenen aantal uitgesproken tekens, en dus
 * een controleerbare transcript-truncatie.
 */

/** Ongeveer Nederlands spreektempo: ~15 tekens per seconde. */
export const FAKE_MS_PER_CHAR = 66;

/** Fragmentgrootte waarin de audio wordt uitgeleverd. */
const CHUNK_MS = 20;

export class FakeTtsStream implements TtsStream {
  private readonly handlers = new Map<string, Function[]>();
  private seq = 0;
  private spokenMs = 0;
  private cancelled = false;
  private queue: string[] = [];

  /** Wat er is uitgesproken, in volgorde. Voor assertions. */
  readonly spoken: string[] = [];
  closed = false;

  constructor(private readonly msPerChar: number = FAKE_MS_PER_CHAR) {}

  on<E extends keyof TtsEvents>(event: E, handler: TtsEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Function);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  say(text: string): void {
    if (this.cancelled) return;
    this.queue.push(text);
    this.spoken.push(text);
    this.synthesise(text);
  }

  /**
   * Levert de audio synchroon uit in fragmenten van 20 ms. Synchroon, omdat een test
   * dan geen timers hoeft af te wachten om te weten hoe ver de spraak is.
   */
  private synthesise(text: string): void {
    const totalMs = Math.round(text.length * this.msPerChar);
    let emitted = 0;

    while (emitted < totalMs && !this.cancelled) {
      const durationMs = Math.min(CHUNK_MS, totalMs - emitted);
      const samples = Math.max(1, Math.round((16_000 * durationMs) / 1000));
      this.emit('audio', {
        pcm: new Int16Array(samples),
        seq: this.seq++,
        durationMs,
      });
      emitted += durationMs;
      this.spokenMs += durationMs;
    }
  }

  /**
   * Sluit de beurt af. `done` hoort hier en niet aan het eind van elke zin: een beurt
   * van drie zinnen is pas klaar als de derde is gesynthetiseerd, en de aanroeper mag
   * niet op de eerste al doorlopen.
   */
  flush(): void {
    if (this.cancelled) return;
    this.emit('done');
  }

  async cancel(): Promise<{ spokenMs: number }> {
    this.cancelled = true;
    this.queue = [];
    return { spokenMs: this.spokenMs };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Verwachte duur van een tekst, zodat een test kan uitrekenen waar hij onderbreekt. */
  durationOf(text: string): number {
    return Math.round(text.length * this.msPerChar);
  }
}

export class FakeTtsProvider implements TextToSpeechProvider {
  readonly id = 'fake';
  stream: FakeTtsStream | null = null;

  constructor(private readonly msPerChar: number = FAKE_MS_PER_CHAR) {}

  async open(_options: TtsOptions): Promise<TtsStream> {
    this.stream = new FakeTtsStream(this.msPerChar);
    return this.stream;
  }
}
