import type { AppClient } from './client';

/**
 * Getypte wrappers rond het RPC-oppervlak uit migratie 0600.
 *
 * Reden om dit hier te centraliseren in plaats van per aanroepplaats `.rpc()` te
 * schrijven: de parameternamen zijn de enige koppeling tussen TypeScript en SQL, en
 * een typefout daarin faalt pas op runtime. Één plek betekent één plek om te
 * corrigeren als een signatuur verandert.
 */

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly rpc: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

async function call<T>(client: AppClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    // Geen argumenten in de melding: die kunnen persoonsgegevens bevatten (§14).
    throw new RpcError(error.message, error.code, fn);
  }
  return data as T;
}

// ------------------------------------------------------------------- publiek

export interface CreatePublicIntakeInput {
  orgSlug: string;
  language: 'nl' | 'en';
  channel: 'video' | 'voice' | 'chat';
  ipHash: string;
  privacyAccepted: boolean;
  privacyPolicyVersion: string;
  aiDisclosureAccepted: boolean;
  aiDisclosureVersion: string;
  cameraConsent: boolean;
  microphoneConsent: boolean;
  userAgentHash?: string | null;
}

export async function createPublicIntake(
  client: AppClient,
  input: CreatePublicIntakeInput,
): Promise<{ intakeId: string; organizationId: string }> {
  const rows = await call<{ intake_id: string; organization_id: string }[]>(
    client,
    'create_public_intake',
    {
      p_org_slug: input.orgSlug,
      p_language: input.language,
      p_channel: input.channel,
      p_ip_hash: input.ipHash,
      p_privacy_accepted: input.privacyAccepted,
      p_privacy_policy_version: input.privacyPolicyVersion,
      p_ai_disclosure_accepted: input.aiDisclosureAccepted,
      p_ai_disclosure_version: input.aiDisclosureVersion,
      p_camera_consent: input.cameraConsent,
      p_microphone_consent: input.microphoneConsent,
      p_user_agent_hash: input.userAgentHash ?? null,
    },
  );
  const row = rows[0];
  if (!row) throw new RpcError('geen intake aangemaakt', undefined, 'create_public_intake');
  return { intakeId: row.intake_id, organizationId: row.organization_id };
}

export async function publicOrgBySlug(
  client: AppClient,
  slug: string,
): Promise<{
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  default_language: 'nl' | 'en';
  privacy_policy_version: string;
  ai_disclosure_version: string;
} | null> {
  const rows = await call<any[]>(client, 'public_org_by_slug', { p_slug: slug });
  return rows[0] ?? null;
}

// --------------------------------------------------------------------- agent

export async function agentStartSession(
  client: AppClient,
  args: {
    intakeId: string;
    channel: 'video' | 'voice' | 'chat';
    roomName: string | null;
    avatarProvider: string | null;
    sttProvider: string | null;
    ttsProvider: string | null;
    llmModel: string | null;
    prewarmedAt?: string | null;
  },
): Promise<string> {
  return call<string>(client, 'agent_start_session', {
    p_intake_id: args.intakeId,
    p_channel: args.channel,
    p_room_name: args.roomName,
    p_avatar_provider: args.avatarProvider,
    p_stt_provider: args.sttProvider,
    p_tts_provider: args.ttsProvider,
    p_llm_model: args.llmModel,
    p_prewarmed_at: args.prewarmedAt ?? null,
  });
}

export async function agentEndSession(
  client: AppClient,
  args: {
    intakeId: string;
    sessionId: string;
    endReason: 'completed' | 'client_left' | 'timeout' | 'error' | 'budget';
    billedSeconds?: number | null;
  },
): Promise<void> {
  await call<void>(client, 'agent_end_session', {
    p_intake_id: args.intakeId,
    p_session_id: args.sessionId,
    p_end_reason: args.endReason,
    p_billed_seconds: args.billedSeconds ?? null,
  });
}

export async function agentAppendMessage(
  client: AppClient,
  args: {
    intakeId: string;
    sessionId: string;
    turnIndex: number;
    role: 'assistant' | 'client' | 'system';
    /** Uitsluitend wat de cliënt daadwerkelijk heeft gehoord of gelezen. */
    content: string;
    intendedContent?: string | null;
    interruptedAtChar?: number | null;
    spokenMs?: number | null;
    plannedQuestionKeys?: string[];
    llmCallId?: string | null;
  },
): Promise<string> {
  return call<string>(client, 'agent_append_message', {
    p_intake_id: args.intakeId,
    p_session_id: args.sessionId,
    p_turn_index: args.turnIndex,
    p_role: args.role,
    p_content: args.content,
    p_intended_content: args.intendedContent ?? null,
    p_interrupted_at_char: args.interruptedAtChar ?? null,
    p_spoken_ms: args.spokenMs ?? null,
    p_planned_question_keys: args.plannedQuestionKeys ?? [],
    p_llm_call_id: args.llmCallId ?? null,
  });
}

export async function agentUpsertFact(
  client: AppClient,
  args: {
    intakeId: string;
    key: string;
    value: unknown;
    valueType: 'string' | 'number' | 'date' | 'boolean' | 'enum';
    status: 'confirmed' | 'inferred' | 'unknown' | 'contradicted';
    confidence: number;
    source: 'client_statement' | 'document' | 'lawyer_input';
    sourceRef: string | null;
    evidenceQuote?: string | null;
    llmCallId?: string | null;
  },
): Promise<string> {
  return call<string>(client, 'agent_upsert_fact', {
    p_intake_id: args.intakeId,
    p_key: args.key,
    p_value: args.value ?? null,
    p_value_type: args.valueType,
    p_status: args.status,
    p_confidence: args.confidence,
    p_source: args.source,
    p_source_ref: args.sourceRef,
    p_evidence_quote: args.evidenceQuote ?? null,
    p_llm_call_id: args.llmCallId ?? null,
  });
}

export async function agentSetRiskFlag(
  client: AppClient,
  args: {
    intakeId: string;
    ruleKey: string;
    level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    label: string;
    detectedBy: 'rule' | 'rule+ai';
    sourceRef?: string | null;
    independentlyConfirmed?: boolean;
  },
): Promise<string> {
  return call<string>(client, 'agent_set_risk_flag', {
    p_intake_id: args.intakeId,
    p_rule_key: args.ruleKey,
    p_level: args.level,
    p_label: args.label,
    p_detected_by: args.detectedBy,
    p_source_ref: args.sourceRef ?? null,
    p_independently_confirmed: args.independentlyConfirmed ?? false,
  });
}

export interface TurnMetrics {
  speechEndToSttFinalMs?: number;
  sttToLlmFirstTokenMs?: number;
  llmToTtsFirstAudioMs?: number;
  ttsToAvatarFirstFrameMs?: number;
  totalResponseLatencyMs?: number;
  interruptToSilenceMs?: number;
  wasInterrupted?: boolean;
}

export async function agentRecordMetric(
  client: AppClient,
  args: { intakeId: string; sessionId: string; turnIndex: number; metrics: TurnMetrics },
): Promise<void> {
  await call<void>(client, 'agent_record_metric', {
    p_intake_id: args.intakeId,
    p_session_id: args.sessionId,
    p_turn_index: args.turnIndex,
    p_metrics: args.metrics,
  });
}

export async function agentLogLlmCall(
  client: AppClient,
  args: {
    intakeId: string;
    sessionId: string | null;
    purpose: 'conversation' | 'extraction' | 'urgency' | 'document' | 'summary';
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number | null;
    schemaValid?: boolean | null;
    repairAttempts?: number;
    promptTemplateKey?: string | null;
    promptVersion?: number | null;
  },
): Promise<string> {
  return call<string>(client, 'agent_log_llm_call', {
    p_intake_id: args.intakeId,
    p_session_id: args.sessionId,
    p_purpose: args.purpose,
    p_model: args.model,
    p_input_tokens: args.inputTokens,
    p_output_tokens: args.outputTokens,
    p_latency_ms: args.latencyMs,
    p_schema_valid: args.schemaValid ?? null,
    p_repair_attempts: args.repairAttempts ?? 0,
    p_prompt_template_key: args.promptTemplateKey ?? null,
    p_prompt_version: args.promptVersion ?? null,
  });
}

export async function agentUpdateProgress(
  client: AppClient,
  args: {
    intakeId: string;
    completeness?: number | null;
    /** De agent mag nooit ACCEPTED/REJECTED/REFERRED zetten; de RPC weigert dat. */
    status?: 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'NEEDS_HUMAN_CHECK' | null;
    subject?: string | null;
    clientName?: string | null;
    clientEmail?: string | null;
    clientPhone?: string | null;
  },
): Promise<void> {
  await call<void>(client, 'agent_update_progress', {
    p_intake_id: args.intakeId,
    p_completeness: args.completeness ?? null,
    p_status: args.status ?? null,
    p_subject: args.subject ?? null,
    p_client_name: args.clientName ?? null,
    p_client_email: args.clientEmail ?? null,
    p_client_phone: args.clientPhone ?? null,
  });
}

export interface AgentContext {
  intake: {
    id: string;
    language: 'nl' | 'en';
    status: string;
    turn_count: number;
    completeness: number | null;
  };
  organization: Record<string, unknown>;
  facts: {
    key: string;
    value: unknown;
    valueType: string;
    status: string;
    confidence: number;
    source: string;
    sourceRef: string | null;
  }[];
  history: {
    id: string;
    role: string;
    content: string;
    interruptedAtChar: number | null;
    plannedQuestionKeys: string[];
    createdAt: string;
  }[];
  pendingLawyerRequests: string[];
  documents: {
    id: string;
    filename: string;
    analysisStatus: string;
    summary: string | null;
    confidence: number | null;
  }[];
}

export async function agentContext(client: AppClient, intakeId: string): Promise<AgentContext> {
  return call<AgentContext>(client, 'agent_context', { p_intake_id: intakeId });
}
