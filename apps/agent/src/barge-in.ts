import {
  INTERRUPT_MIN_SPEECH_MS,
  INTERRUPT_MIN_WORDS,
  isBackchannel,
  type Language,
} from '@intake/domain';

/**
 * Wanneer onderbreekt de cliënt écht?
 *
 * Gelaagd, omdat de snelste detectie ook de meest foutgevoelige is. De client-side VAD
 * dempt de avatar meteen — optimistisch en omkeerbaar, want als het loos alarm was komt
 * het geluid binnen 200 ms terug. Deze functie beslist over de harde interrupt, en die
 * is niet omkeerbaar: hij annuleert de generatie en kapt het transcript af.
 *
 * De twee foutkanten zijn niet symmetrisch. Te snel onderbreken maakt de assistent
 * schrikachtig: hij valt stil bij elk "ja". Te laat onderbreken maakt hem doof. Van die
 * twee is doof erger, dus de drempel ligt laag — met één uitzondering.
 *
 * Die uitzondering is de backchannel. "Ja", "mm-hm", "precies" zijn geen onderbrekingen
 * maar bevestigingen; ze horen het gesprek juist door te laten lopen. Ze gaan als
 * bevestigingssignaal naar de engine.
 */

export interface SpeechEvidence {
  /** Aaneengesloten spraakenergie uit de client-VAD, in milliseconden. */
  readonly speechMs: number;
  /** Eerste partial van de STT, als die er al is. */
  readonly text?: string;
}

export type BargeInDecision =
  | { readonly kind: 'interrupt'; readonly reason: 'speech_duration' | 'word_count' }
  | { readonly kind: 'backchannel'; readonly text: string }
  | { readonly kind: 'ignore'; readonly reason: 'te_kort' };

export function classifySpeech(evidence: SpeechEvidence, language: Language): BargeInDecision {
  const text = evidence.text?.trim() ?? '';

  // Eerst de backchannel, en bewust vóór de duurdrempel: "precies" duurt langer dan
  // 180 ms en zou anders alsnog onderbreken.
  if (text.length > 0 && isBackchannel(text, evidence.speechMs, language)) {
    return { kind: 'backchannel', text };
  }

  const words = text.length > 0 ? text.split(/\s+/u).filter(Boolean).length : 0;
  if (words >= INTERRUPT_MIN_WORDS) {
    return { kind: 'interrupt', reason: 'word_count' };
  }
  if (evidence.speechMs >= INTERRUPT_MIN_SPEECH_MS) {
    return { kind: 'interrupt', reason: 'speech_duration' };
  }

  return { kind: 'ignore', reason: 'te_kort' };
}

export function shouldInterrupt(evidence: SpeechEvidence, language: Language): boolean {
  return classifySpeech(evidence, language).kind === 'interrupt';
}
