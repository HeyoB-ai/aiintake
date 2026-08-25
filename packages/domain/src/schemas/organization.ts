import { z } from 'zod';
import { AvatarProviderIdSchema, LanguageSchema, UrgencyLevelSchema } from '../enums';

/** Providerkeuze per organisatie; defaults komen uit env (§5). */
export const ProviderConfigSchema = z
  .object({
    avatar: AvatarProviderIdSchema.default('null'),
    avatarId: z.string().nullable().default(null),
    stt: z.enum(['deepgram', 'fake']).default('deepgram'),
    tts: z.enum(['cartesia', 'elevenlabs', 'fake']).default('cartesia'),
    ttsVoiceId: z.string().nullable().default(null),
    llmHot: z.string().default('claude-haiku-4-5-20251001'),
    llmCold: z.string().default('claude-sonnet-5'),
  })
  .default({});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** Kostenbeheersing (§7). Overschrijding valt terug op chat, weigert niet. */
export const SessionLimitsSchema = z
  .object({
    maxSessionMinutes: z.number().int().positive().max(120).default(25),
    inactivityTimeoutSeconds: z.number().int().positive().max(600).default(90),
    maxConcurrentSessions: z.number().int().positive().max(100).default(5),
    monthlyBudgetEurCents: z.number().int().nonnegative().default(50_000),
    /** Bij overschrijding: video uit, chat aan. Nooit een dichte deur. */
    fallbackToChatOnBudget: z.boolean().default(true),
  })
  .default({});
export type SessionLimits = z.infer<typeof SessionLimitsSchema>;

/** Acceptatiedrempels van het kantoor; wegen mee in de QuestionPlanner. */
export const IntakeCriteriaSchema = z
  .object({
    minMonthlySalary: z.number().nonnegative().nullable().default(null),
    minEmploymentMonths: z.number().int().nonnegative().nullable().default(null),
    acceptIfOtherCounsel: z.boolean().default(false),
    requireLegalExpensesInsurance: z.boolean().default(false),
    autoFlagFrom: UrgencyLevelSchema.default('HIGH'),
  })
  .default({});
export type IntakeCriteria = z.infer<typeof IntakeCriteriaSchema>;

export const RetentionPolicySchema = z
  .object({
    /** Audio/video bij de avatarvendor. Contractueel ≤ 24 uur; wij bewaren niets. */
    mediaRetentionHours: z.number().int().nonnegative().max(24).default(0),
    transcriptRetentionDays: z.number().int().positive().default(365),
    documentRetentionDays: z.number().int().positive().default(365),
    /** Efemere signalen; hooguit geaggregeerd voor debugging. */
    visualSignalRetentionHours: z.number().int().nonnegative().max(72).default(0),
    rejectedIntakeRetentionDays: z.number().int().positive().default(90),
  })
  .default({});
export type RetentionPolicy = z.infer<typeof RetentionPolicySchema>;

export const OrgConfigSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(2).max(60),
  name: z.string().min(1).max(200),
  defaultLanguage: LanguageSchema.default('nl'),
  /**
   * De tijdzone van het kantoor, als IANA-naam.
   *
   * Hier en niet als constante in de code. Een Belgisch of Duits kantoor zit toevallig in
   * dezelfde zone als een Nederlands, maar dat is een eigenschap van het kantoor en geen
   * eigenschap van het product — en zodra er één kantoor buiten die zone bij komt, is een
   * hardgecodeerde waarde een stille fout in plaats van een instelling.
   *
   * Waar het op uitkomt: de groet ("goedemorgen" hangt van het lokale uur af) en, veel
   * belangrijker, het ankerpunt waarmee de extractie "afgelopen vrijdag" naar een datum
   * omrekent. De server draait op UTC; tussen middernacht en twee uur 's nachts scheelt
   * dat een hele dag in `case_facts`.
   */
  timeZone: z.string().min(3).max(64).default('Europe/Amsterdam'),
  providerConfig: ProviderConfigSchema,
  sessionLimits: SessionLimitsSchema,
  intakeCriteria: IntakeCriteriaSchema,
  retentionPolicy: RetentionPolicySchema,
  /** Publiceert de cliëntcamera naar de room? Standaard uit — zie ADR-0004. */
  publishClientVideo: z.boolean().default(false),
});
export type OrgConfig = z.infer<typeof OrgConfigSchema>;
