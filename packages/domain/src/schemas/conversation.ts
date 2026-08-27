import { backchannelsVoor } from '../korte-uitingen';
import { z } from 'zod';
import { ChannelSchema, LanguageSchema, MessageRoleSchema } from '../enums';

/**
 * Eén beurt in het gesprek.
 *
 * `content` bevat alleen wat de cliënt DAADWERKELIJK heeft gehoord of gelezen.
 * Bij een barge-in wordt de assistant-beurt afgekapt op de uitgesproken prefix en
 * `interruptedAtChar` gezet (§7 stap d). Zonder die truncatie gelooft het model dat
 * het vragen heeft gesteld die nooit hoorbaar waren, en bouwt het gesprek verder op
 * gedeelde context die niet bestaat.
 */
export const TurnSchema = z.object({
  id: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  /** Wat het model *wilde* zeggen. Alleen voor audit; nooit als history naar het LLM. */
  intendedContent: z.string().nullable().optional(),
  /** Aantal tekens dat daadwerkelijk is uitgesproken vóór de interrupt. */
  interruptedAtChar: z.number().int().nonnegative().nullable().optional(),
  spokenMs: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.string().datetime(),
  /** Welke fact-sleutels wilde de planner met deze beurt ophalen? Voor herhalingsdetectie. */
  plannedQuestionKeys: z.array(z.string()).default([]),
});
export type Turn = z.infer<typeof TurnSchema>;

export function wasInterrupted(turn: Turn): boolean {
  return turn.interruptedAtChar != null;
}

/**
 * Kapt een assistant-beurt af op wat werkelijk is uitgesproken.
 *
 * `spokenMs` komt uit `AvatarSession.interrupt()`. Levert de TTS-provider
 * woordtijdstempels, gebruik die; anders is een lineaire schatting op tekenaantal de
 * verdedigbare benadering — te veel afkappen is veiliger dan te weinig, want een
 * vraag opnieuw stellen is onschuldig en een niet-gestelde vraag als gesteld
 * beschouwen niet.
 */
export function truncateToSpoken(
  intended: string,
  spokenMs: number,
  totalMs: number,
  wordTimings?: readonly { readonly charIndex: number; readonly startMs: number }[],
): { content: string; interruptedAtChar: number } {
  if (totalMs <= 0 || spokenMs >= totalMs) {
    return { content: intended, interruptedAtChar: intended.length };
  }
  if (wordTimings && wordTimings.length > 0) {
    let charIndex = 0;
    for (const timing of wordTimings) {
      if (timing.startMs > spokenMs) break;
      charIndex = timing.charIndex;
    }
    return { content: intended.slice(0, charIndex), interruptedAtChar: charIndex };
  }
  const ratio = Math.max(0, Math.min(1, spokenMs / totalMs));
  const charIndex = Math.floor(intended.length * ratio);
  return { content: intended.slice(0, charIndex), interruptedAtChar: charIndex };
}

/**
 * De andere helft van dezelfde afspraak: wat de cliënt júíst niet meer heeft gehoord.
 *
 * ## Waarom dit hier staat en niet in het scherm
 *
 * Het stond in `transcript.tsx`, als een losse `intended_content.slice(interrupted_at_char)`
 * midden in een React-component. Dat is dezelfde conventie als hierboven, een tweede keer
 * opgeschreven — en op de plek waar een advocaat leest wat de cliënt wél en niet heeft
 * meegekregen.
 *
 * Verschuift de betekenis van `interruptedAtChar` ooit een teken, dan zegt het dossier dat de
 * cliënt iets heeft gehoord dat hij niet hoorde, of andersom. Bij een intake die juridisch
 * wordt beoordeeld is dat geen weergavefoutje: het bepaalt of een vraag als gesteld geldt.
 *
 * De twee horen dus bij elkaar en zijn samen te toetsen. `truncateToSpoken(x).content +
 * nietGehoord(x)` is weer `x` — die eis staat in de test en is er niet aan af te lezen zolang
 * de helften in verschillende pakketten wonen.
 *
 * Leeg als er niets is afgekapt.
 */
export function nietGehoord(intended: string | null, interruptedAtChar: number | null): string {
  if (intended === null || interruptedAtChar === null) return '';
  if (interruptedAtChar < 0 || interruptedAtChar >= intended.length) return '';
  return intended.slice(interruptedAtChar);
}

/**
 * Korte bevestigingen die het gesprek NIET onderbreken (§7). Ze gaan als
 * bevestigingssignaal naar de engine.
 */
/*
 * Afgeleid uit één tabel, niet meer met de hand bijgehouden.
 *
 * Deze twee lijsten en de inhoudsloze-woordenlijst in affirmation.ts liepen uiteen zonder dat
 * iemand dat had besloten: "inderdaad" onderbrak de assistent én werd als bewijs geweigerd,
 * "mm-hm" deed geen van beide. Zie korte-uitingen.ts, waar per woord staat wat het mag en
 * waarom de twee kolommen verschillen als ze verschillen.
 */
export const BACKCHANNELS_NL: readonly string[] = backchannelsVoor('nl');
export const BACKCHANNELS_EN: readonly string[] = backchannelsVoor('en');

export const BACKCHANNEL_MAX_MS = 400;
export const INTERRUPT_MIN_SPEECH_MS = 180;
export const INTERRUPT_MIN_WORDS = 2;

/**
 * Stilte in ms voordat de beurt van de cliënt sluit — hoe snel de assistent begint te praten.
 *
 * **700 en niet 300, en dat is een gemeten waarde.** De 300 kwam uit de spec en is nooit
 * beproefd; hij knipt midden in een denkpauze. 700 is op gehoor afgesteld in gevoerde
 * gesprekken en werkt. Zolang dat als afwijking in één omgeving stond, draaide elke tweede
 * omgeving op 300 en was niet te begrijpen waarom het daar slechter klonk.
 *
 * Staat hier en niet in `drempels.ts` of in de Deepgram-adapter, omdat het getal daar tot
 * vandaag twéé keer stond: `standaard: 300` in de drempellaag en `?? 300` in de adapter. Dat is
 * dezelfde vorm als de samplerate en de tijdzone — één grootheid, meerdere plekken, en de plek
 * die achterloopt is vanaf de andere niet te zien.
 */
export const ENDPOINTING_MS = 700;

/**
 * Vangnet dat de beurt sluit op gaten tussen woordtijdstempels.
 *
 * Deepgram accepteert onder de 1000 niet. Voedt ook `continuationInterval`, de detector voor
 * een te vroege knip.
 */
export const UTTERANCE_END_MS = 1_000;

/**
 * `maxMs` is optioneel en valt terug op de constante hierboven.
 *
 * De parameter bestaat zodat de worker hem uit de omgeving kan afwijken zonder deploy — het
 * gedrag is alleen op gehoor af te stellen. Het domein leest die omgeving niet zelf: dan zou
 * een rekenregel afhangen van waar hij toevallig draait, en meet een test iets anders dan
 * productie. Zie apps/agent/src/drempels.ts.
 */
export function isBackchannel(
  text: string,
  durationMs: number,
  language: 'nl' | 'en',
  maxMs: number = BACKCHANNEL_MAX_MS,
): boolean {
  if (durationMs >= maxMs) return false;
  const list: readonly string[] = language === 'nl' ? BACKCHANNELS_NL : BACKCHANNELS_EN;
  const normalised = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?]+$/u, '');
  return list.includes(normalised);
}

export const ConversationContextSchema = z.object({
  channel: ChannelSchema,
  language: LanguageSchema,
  turns: z.array(TurnSchema),
});
export type ConversationContext = z.infer<typeof ConversationContextSchema>;
