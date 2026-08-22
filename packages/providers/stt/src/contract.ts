import type { Language } from '@intake/domain';

/**
 * Spraakherkenning: streaming, met end-of-turn-detectie.
 *
 * De belangrijkste eis staat in de events, niet in de transcriptie: `end_of_turn` moet
 * door het model worden bepaald en niet door een vaste stiltedrempel. Een VAD-timer van
 * 700 ms is 700 ms die je in élke beurt betaalt, en dat is bijna de helft van het
 * latencybudget.
 *
 * `start_of_turn` is de autoritatieve barge-in-trigger. De client-side VAD dempt de
 * avatar alvast (optimistisch en omkeerbaar); dit event bepaalt of er écht onderbroken
 * wordt.
 */

export interface SttOptions {
  readonly language: Language;
  /** Juridisch jargon dat het model anders structureel misverstaat. Zie keyterms.ts. */
  readonly keyterms: readonly string[];
  /** 16 kHz mono PCM is wat vrijwel elke leverancier verwacht. */
  readonly sampleRate?: number;
}

export interface TurnEndMeta {
  /** Tijdstip op dezelfde klok als de rest van de lus (`performance.now()`-basis). */
  readonly speechEndedAt: number;
}

export interface SttEvents {
  /** Tussentijds resultaat; mag wijzigen. Alleen voor de UI, nooit voor de engine. */
  partial: (text: string) => void;
  /** Definitief transcript van een beurt. */
  final: (text: string) => void;
  /** De cliënt begint te praten. Autoritatieve barge-in-trigger. */
  start_of_turn: () => void;
  /**
   * De cliënt is uitgesproken. Start van de responscyclus.
   *
   * `speechEndedAt` is het moment waarop het laatste woord eindigde, niet het moment
   * waarop wij dat te horen kregen. Dat verschil ís de endpointing-latency, en zonder
   * dit veld is die niet te meten: de lus weet alleen wanneer het event binnenkwam.
   */
  end_of_turn: (text: string, meta: TurnEndMeta) => void;
  error: (error: Error) => void;
}

export interface SttStream {
  push(pcm: Int16Array): void;
  on<E extends keyof SttEvents>(event: E, handler: SttEvents[E]): void;
  close(): Promise<void>;
}

export interface SpeechToTextProvider {
  readonly id: string;
  connect(options: SttOptions): Promise<SttStream>;
}
