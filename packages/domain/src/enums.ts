import { z } from 'zod';

/**
 * Enums zijn hier de bron van waarheid. De SQL check-constraints in
 * supabase/migrations spiegelen deze lijsten; `packages/db/src/__tests__` bewaakt
 * dat de twee niet uit elkaar lopen.
 */

export const ROLES = ['SUPER_ADMIN', 'ORG_ADMIN', 'LAWYER', 'INTAKE_STAFF'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** Rangorde voor autorisatiechecks. Hoger = meer rechten. */
export const ROLE_RANK: Record<Role, number> = {
  INTAKE_STAFF: 1,
  LAWYER: 2,
  ORG_ADMIN: 3,
  SUPER_ADMIN: 4,
};

export const INTAKE_STATUSES = [
  'NEW',
  'IN_PROGRESS',
  'READY_FOR_REVIEW',
  'MORE_INFO_REQUESTED',
  'ACCEPTED',
  'REJECTED',
  'REFERRED',
  /** Samenvatting bevatte een niet-herleidbare bewering (§10). Nooit als "klaar" tonen. */
  'NEEDS_HUMAN_CHECK',
] as const;
export const IntakeStatusSchema = z.enum(INTAKE_STATUSES);
export type IntakeStatus = z.infer<typeof IntakeStatusSchema>;

export const URGENCY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const UrgencyLevelSchema = z.enum(URGENCY_LEVELS);
export type UrgencyLevel = z.infer<typeof UrgencyLevelSchema>;

export const URGENCY_RANK: Record<UrgencyLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * `unknown` is een expliciete, opslaanbare waarde (§4). "Niet vastgesteld" is een
 * feit, geen leegte — dat onderscheid draagt de hele samenvattingslogica.
 */
export const FACT_STATUSES = ['confirmed', 'inferred', 'unknown', 'contradicted'] as const;
export const FactStatusSchema = z.enum(FACT_STATUSES);
export type FactStatus = z.infer<typeof FactStatusSchema>;

/**
 * Waar een feit vandaan komt.
 *
 * `client_form` is wat de client zelf op het toestemmingsscherm heeft ingevuld. Bewust apart
 * van `client_statement`: dat laatste betekent "in het gesprek gezegd" en draagt een citaat,
 * en een formulierveld heeft er geen. Voor een advocaat is dat verschil inhoudelijk — ingetypt
 * is anders geverifieerd dan verstaan.
 */
export const FACT_SOURCES = [
  'client_statement',
  'document',
  'lawyer_input',
  'client_form',
] as const;
export const FactSourceSchema = z.enum(FACT_SOURCES);
export type FactSource = z.infer<typeof FactSourceSchema>;

export const VALUE_TYPES = ['string', 'number', 'date', 'boolean', 'enum'] as const;
export const ValueTypeSchema = z.enum(VALUE_TYPES);
export type ValueType = z.infer<typeof ValueTypeSchema>;

export const CHANNELS = ['video', 'voice', 'chat'] as const;
export const ChannelSchema = z.enum(CHANNELS);
export type Channel = z.infer<typeof ChannelSchema>;

export const END_REASONS = ['completed', 'client_left', 'timeout', 'error', 'budget'] as const;
export const EndReasonSchema = z.enum(END_REASONS);
export type EndReason = z.infer<typeof EndReasonSchema>;

export const PRACTICE_AREAS = ['employment'] as const;
export const PracticeAreaSchema = z.enum(PRACTICE_AREAS);
export type PracticeArea = z.infer<typeof PracticeAreaSchema>;

export const LANGUAGES = ['nl', 'en'] as const;
export const LanguageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof LanguageSchema>;

export const LLM_PURPOSES = [
  'conversation',
  'extraction',
  'urgency',
  'document',
  'summary',
] as const;
export const LlmPurposeSchema = z.enum(LLM_PURPOSES);
export type LlmPurpose = z.infer<typeof LlmPurposeSchema>;

export const AVATAR_PROVIDERS = ['beyondpresence', 'anam', 'null'] as const;
export const AvatarProviderIdSchema = z.enum(AVATAR_PROVIDERS);
export type AvatarProviderId = z.infer<typeof AvatarProviderIdSchema>;

export const MESSAGE_ROLES = ['assistant', 'client', 'system'] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const DOCUMENT_ANALYSIS_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'rejected',
] as const;
export const DocumentAnalysisStatusSchema = z.enum(DOCUMENT_ANALYSIS_STATUSES);
export type DocumentAnalysisStatus = z.infer<typeof DocumentAnalysisStatusSchema>;

/** Auditgebeurtenissen. Uitbreidbaar, maar nooit stilzwijgend hernoemen. */
export const AUDIT_ACTIONS = [
  'intake.created',
  'intake.status_changed',
  'intake.assigned',
  'intake.viewed',
  'intake.exported',
  'intake.deleted',
  'session.started',
  'session.ended',
  'document.uploaded',
  'document.downloaded',
  'document.deleted',
  'summary.generated',
  'summary.flagged_for_review',
  'lawyer_request.created',
  'consent.recorded',
  'user.invited',
  'user.role_changed',
  'user.removed',
  'org.settings_changed',
  'retention.purged',
] as const;
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;
