import type { SpeechToTextProvider, SttEvents, SttOptions, SttStream } from './contract';

/**
 * Scriptbare STT voor tests en voor het draaien van de lus zonder leverancier.
 *
 * Geen timers, geen willekeur: de test bepaalt zelf wanneer een beurt eindigt en
 * wanneer de cliënt onderbreekt. Dat is wat een barge-in-test bruikbaar maakt — met
 * echte spraak kun je niet reproduceerbaar op exact 340 ms interrumperen.
 */
export class FakeSttStream implements SttStream {
  private readonly handlers = new Map<string, Function[]>();
  /** Wat er is binnengekomen; voor tests die willen weten of audio doorstroomde. */
  readonly received: Int16Array[] = [];
  closed = false;

  push(pcm: Int16Array): void {
    this.received.push(pcm);
  }

  on<E extends keyof SttEvents>(event: E, handler: SttEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Function);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  // ---- besturing vanuit de test

  /** De cliënt begint te praten. Bij een lopende beurt is dit de barge-in. */
  startOfTurn(): void {
    this.emit('start_of_turn');
  }

  partial(text: string): void {
    this.emit('partial', text);
  }

  /**
   * De cliënt is uitgesproken; hierna start de responscyclus.
   *
   * `speechEndedAt` is instelbaar zodat een test endpointing-latency kan naspelen: geef
   * een tijdstip in het verleden mee en de lus meet precies dat verschil.
   */
  endOfTurn(text: string, speechEndedAt = performance.now()): void {
    this.emit('final', text);
    this.emit('end_of_turn', text, { speechEndedAt, endedBy: 'speech_final' });
  }

  /**
   * Er kwamen alsnog woorden binnen die bij de vorige beurt hoorden: de knip was te
   * vroeg. Zie RISICOS.md risico 2.
   */
  continueTurn(text: string, gapMs = 120, previous = ''): void {
    this.emit('turn_continued', text, {
      gapMs,
      detectedBy: 'word_gap',
      fullUtterance: `${previous} ${text}`.trim(),
    });
  }

  fail(message: string): void {
    this.emit('error', new Error(message));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeSttProvider implements SpeechToTextProvider {
  readonly id = 'fake';
  /** De laatst geopende stream, zodat een test hem kan aansturen. */
  stream: FakeSttStream | null = null;
  lastOptions: SttOptions | null = null;

  async connect(options: SttOptions): Promise<SttStream> {
    this.lastOptions = options;
    this.stream = new FakeSttStream();
    return this.stream;
  }
}
