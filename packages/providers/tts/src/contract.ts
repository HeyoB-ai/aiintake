import type { Language } from '@intake/domain';

/**
 * Spraaksynthese: streaming en annuleerbaar.
 *
 * `cancel()` is hier de zwaarste eis, niet de stemkwaliteit. Bij een barge-in moet het
 * binnen 50 ms stil zijn; alles daarboven hoort de cliënt als doorpraten nadat hij is
 * begonnen, en dat is precies het gedrag dat een gesprek onmenselijk maakt.
 *
 * De verbinding blijft de hele sessie open. Per beurt een WebSocket opzetten kost
 * 100–200 ms die je in het latencybudget niet hebt.
 */

export interface TtsOptions {
  readonly voiceId: string;
  readonly language: Language;
  /** 16 kHz mono PCM sluit aan op wat de avatarlaag verwacht. */
  readonly sampleRate?: number;
}

export interface TtsAudioChunk {
  readonly pcm: Int16Array;
  /** Oplopend per chunk binnen één beurt; de avatarlaag gebruikt dit voor volgorde. */
  readonly seq: number;
  /** Duur van dit fragment. Basis voor de spokenMs-boekhouding bij een barge-in. */
  readonly durationMs: number;
}

export interface TtsEvents {
  audio: (chunk: TtsAudioChunk) => void;
  /** Alle tekst die is aangeboden, is gesynthetiseerd. */
  done: () => void;
  error: (error: Error) => void;
}

export interface TtsStream {
  /** Eén zin. De aanroeper flusht zinsgewijs; zie SentenceFlusher. */
  say(text: string): void;
  /**
   * Er komt geen tekst meer bij voor deze beurt. Daarna volgt `done` zodra alles is
   * gesynthetiseerd.
   *
   * Dit hoort in het contract omdat de beurt anders niet af te ronden is: een echte
   * leverancier levert audio ná de laatste `say()`, over het netwerk. Wie de beurt
   * afsluit zodra de tekststream eindigt, mist die audio — en daarmee ook de meting van
   * eerste audio en eerste frame.
   */
  flush(): void;
  /**
   * Onmiddellijk stoppen en de wachtrij weggooien. Moet binnen 50 ms stilte opleveren.
   * Geeft terug hoeveel milliseconden er daadwerkelijk is uitgesproken — dat getal
   * draagt de transcript-truncatie.
   */
  cancel(): Promise<{ spokenMs: number }>;
  on<E extends keyof TtsEvents>(event: E, handler: TtsEvents[E]): void;
  close(): Promise<void>;
}

export interface TextToSpeechProvider {
  readonly id: string;
  open(options: TtsOptions): Promise<TtsStream>;
}
