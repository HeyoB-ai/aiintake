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
 * Korte bevestigingen die het gesprek NIET onderbreken (§7). Ze gaan als
 * bevestigingssignaal naar de engine.
 */
export const BACKCHANNELS_NL = [
  'ja',
  'jazeker',
  'mm-hm',
  'mmhm',
  'oké',
  'oke',
  'hm',
  'precies',
  'klopt',
  'juist',
] as const;
export const BACKCHANNELS_EN = [
  'yes',
  'yeah',
  'mm-hm',
  'mmhm',
  'okay',
  'ok',
  'right',
  'sure',
  'uh-huh',
] as const;

export const BACKCHANNEL_MAX_MS = 400;
export const INTERRUPT_MIN_SPEECH_MS = 180;
export const INTERRUPT_MIN_WORDS = 2;

export function isBackchannel(text: string, durationMs: number, language: 'nl' | 'en'): boolean {
  if (durationMs >= BACKCHANNEL_MAX_MS) return false;
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
