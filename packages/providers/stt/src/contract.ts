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
  /**
   * Hoe de beurt werd afgesloten.
   *
   * `speech_final` is het normale pad: het model zegt dat de zin af is. `utterance_end`
   * is het vangnet — Deepgram zag `utterance_end_ms` aan stilte en sluit af omdat het
   * laatste woord niet als final doorkwam.
   *
   * Dat onderscheid hoort in de meting. Een beurt via het vangnet kost per definitie
   * minstens `utterance_end_ms` aan endpointing, dus zo'n uitschieter is geen aarzelende
   * cliënt maar een ander codepad. Zonder dit veld lijken die twee identiek.
   */
  readonly endedBy: 'speech_final' | 'utterance_end';
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
  /**
   * De beurt sloot af zonder één bruikbaar woord.
   *
   * Deepgram meldt `SpeechStarted` op energie, niet op taal. Een kuch, een deur, een
   * stoel — of spraak die de herkenner niet als woorden kon lezen — geeft een beurt die
   * begint en eindigt met een lege `pending`.
   *
   * Dat gebeurde tot nu toe met een `return` en verder niets: geen event, geen melding,
   * geen spoor. Van buiten is dat niet te onderscheiden van "de cliënt heeft niets
   * gezegd", terwijl het ook "de cliënt heeft iets gezegd en wij verstonden er geen woord
   * van" kan betekenen. Die twee horen niet dezelfde stilte op te leveren.
   *
   * Dit is dus een dataverlies-signaal, net als `turn_continued`, en geen foutmelding: de
   * lus hoeft er niets mee te doen behalve het zichtbaar maken.
   */
  empty_turn: (meta: EmptyTurnMeta) => void;
  error: (error: Error) => void;
}

export interface EmptyTurnMeta {
  /** Hoe de beurt werd afgesloten; dezelfde twee wegen als bij `end_of_turn`. */
  readonly endedBy: 'speech_final' | 'utterance_end';
  /**
   * Hoeveel losse `Results`-berichten er in deze beurt zijn langsgekomen.
   *
   * Nul betekent: er is nooit tekst geweest, ook geen tussentijdse. Meer dan nul betekent
   * dat de herkenner wél iets zag en het bij het afsluiten alsnog leeg was — een ander
   * geval, en het interessantere van de twee.
   */
  readonly resultaten: number;
  /**
   * De langste transcripttekst die in deze beurt langskwam, in tekens.
   *
   * Dit veld maakt de melding beslisbaar. Nul betekent: de herkenner heeft geen woord
   * gezien — een kuch, een deur, een stoel. **Meer dan nul betekent dataverlies**: er
   * waren woorden en ze zijn onderweg verdwenen, vrijwel zeker omdat ze alleen als
   * tussentijds resultaat kwamen en `pending` uitsluitend op `is_final` stapelt.
   *
   * Alleen de lengte en nooit de tekst: §14 verbiedt transcriptfragmenten in logs, en voor
   * dit onderscheid is de lengte genoeg.
   */
  readonly tekensGezien: number;
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
