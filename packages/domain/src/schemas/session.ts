import { z } from 'zod';
import { AvatarProviderIdSchema, ChannelSchema, EndReasonSchema } from '../enums';

export const SessionSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  intakeId: z.string().uuid(),
  channel: ChannelSchema,
  roomName: z.string().nullable(),
  avatarProvider: AvatarProviderIdSchema.nullable(),
  avatarSessionId: z.string().nullable(),
  sttProvider: z.string().nullable(),
  ttsProvider: z.string().nullable(),
  llmModel: z.string().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  endReason: EndReasonSchema.nullable(),
  billedSeconds: z.number().int().nonnegative().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * De latencybegroting per beurt (§4). Wordt live in de HUD getoond en weggeschreven,
 * zodat regressies zichtbaar worden over releases heen in plaats van voelbaar.
 */
export const SessionMetricSchema = z.object({
  sessionId: z.string().uuid(),
  turnIndex: z.number().int().nonnegative(),
  speechEndToSttFinalMs: z.number().int().nonnegative().nullable(),
  sttToLlmFirstTokenMs: z.number().int().nonnegative().nullable(),
  llmToTtsFirstAudioMs: z.number().int().nonnegative().nullable(),
  ttsToAvatarFirstFrameMs: z.number().int().nonnegative().nullable(),
  totalResponseLatencyMs: z.number().int().nonnegative().nullable(),
  interruptToSilenceMs: z.number().int().nonnegative().nullable(),
  wasInterrupted: z.boolean().default(false),
});
export type SessionMetric = z.infer<typeof SessionMetricSchema>;

/** Doelbudget uit §4 van het architectuurdocument. De HUD kleurt af tegen deze waarden. */
export const LATENCY_BUDGET_MS = {
  endpointing: { p50: 220, p95: 350 },
  llmFirstToken: { p50: 300, p95: 600 },
  ttsFirstAudio: { p50: 80, p95: 180 },
  avatarFirstFrame: { p50: 180, p95: 350 },
  network: { p50: 40, p95: 90 },
  total: { p50: 820, p95: 1600 },
  /** Fase 1 is klaar bij p50 < 1500 ms; productiedoel is 1200 ms. */
  gateFase1: 1500,
  productionTarget: 1200,
  /** Barge-in: TTS moet binnen deze tijd stil zijn. */
  interruptToSilence: 50,
} as const;

export const LlmCallSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  intakeId: z.string().uuid().nullable(),
  sessionId: z.string().uuid().nullable(),
  purpose: z.enum(['conversation', 'extraction', 'urgency', 'document', 'summary']),
  model: z.string(),
  promptTemplateId: z.string().uuid().nullable(),
  promptVersion: z.number().int().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  schemaValid: z.boolean().nullable(),
  repairAttempts: z.number().int().nonnegative().default(0),
});
export type LlmCall = z.infer<typeof LlmCallSchema>;

export const ConsentRecordSchema = z.object({
  intakeId: z.string().uuid(),
  privacyAccepted: z.boolean(),
  privacyPolicyVersion: z.string(),
  aiDisclosureAccepted: z.boolean(),
  aiDisclosureVersion: z.string(),
  cameraConsent: z.boolean(),
  microphoneConsent: z.boolean(),
  recordingConsent: z.boolean().default(false),
  acceptedAt: z.string().datetime(),
  /** Gehasht, niet ruw — de user agent is een identificerend gegeven. */
  userAgentHash: z.string().nullable(),
});
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;
