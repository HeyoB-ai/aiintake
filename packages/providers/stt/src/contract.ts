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

export interface ContinuationMeta {
  /** Gat tussen het einde van de afgesloten beurt en het eerste nieuwe woord. */
  readonly gapMs: number;
  /** Welk signaal de knip verraadde. */
  readonly detectedBy: 'word_gap' | 'utterance_end';
  /** De afgesloten beurt plus wat er alsnog binnenkwam. */
  readonly fullUtterance: string;
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
  /**
   * De vorige beurt was te vroeg afgesloten: er kwamen woorden binnen die bij dezelfde
   * uitspraak hoorden.
   *
   * Dit is geen latencysignaal maar een dataverlies-signaal. Zonder dit event verdwijnt
   * de rest van de zin geruisloos: de engine heeft de beurt al verwerkt en er is geen
   * foutmelding, alleen een transcript dat grammaticaal klopt en inhoudelijk incompleet
   * is. Zie RISICOS.md risico 2.
   */
  turn_continued: (text: string, meta: ContinuationMeta) => void;
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
