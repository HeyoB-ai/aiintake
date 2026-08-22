import type { AppClient } from './client';

/**
 * Getypte wrappers rond het RPC-oppervlak uit migratie 0600.
 *
 * Reden om dit te centraliseren in plaats van per aanroepplaats `.rpc()` te schrijven:
 * de parameternamen zijn de enige koppeling tussen TypeScript en SQL, en een typefout
 * daarin faalt pas op runtime.
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

/** Het token is ongeldig, verlopen of ingetrokken: de sessie moet stoppen. */
export class AgentTokenRejected extends RpcError {
  constructor(message: string, code: string | undefined, rpc: string) {
    super(message, code, rpc);
    this.name = 'AgentTokenRejected';
  }
}

async function call<T>(client: AppClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    // Geen argumenten in de melding: die bevatten het sessietoken en mogelijk
    // persoonsgegevens (§14).
    if (error.code === '42501') {
      throw new AgentTokenRejected(error.message, error.code, fn);
    }
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

export interface TurnMetrics {
  speechEndToSttFinalMs?: number;
  sttToLlmFirstTokenMs?: number;
  llmToTtsFirstAudioMs?: number;
  ttsToAvatarFirstFrameMs?: number;
  totalResponseLatencyMs?: number;
  interruptToSilenceMs?: number;
  wasInterrupted?: boolean;
}

export interface AgentContext {
  sessionId: string;
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

/**
 * Alles wat de worker mag doen, gebonden aan één token en één intake.
 *
 * Token en intake-id worden hier één keer vastgelegd in plaats van bij elke aanroep
 * meegegeven. Dat scheelt niet alleen herhaling: het maakt het onmogelijk om per
 * ongeluk een token van sessie A met een intake-id van B te combineren. De database
 * zou dat weigeren, maar een fout die niet te maken is, hoeft ook niet geweigerd te
 * worden.
 *
 * De sessie-id komt uit het token en is dus geen parameter — de RPC leidt hem af.
 */
export interface AgentRpc {
  readonly intakeId: string;
  context(): Promise<AgentContext>;
  setSessionProviders(providers: {
    avatar: string | null;
    stt: string | null;
    tts: string | null;
    llmModel: string | null;
  }): Promise<void>;
  appendMessage(args: {
    turnIndex: number;
    role: 'assistant' | 'client' | 'system';
    /** Uitsluitend wat de cliënt daadwerkelijk heeft gehoord of gelezen. */
    content: string;
    intendedContent?: string | null;
    interruptedAtChar?: number | null;
    spokenMs?: number | null;
    plannedQuestionKeys?: string[];
    llmCallId?: string | null;
  }): Promise<string>;
  upsertFact(args: {
    key: string;
    value: unknown;
    valueType: 'string' | 'number' | 'date' | 'boolean' | 'enum';
    status: 'confirmed' | 'inferred' | 'unknown' | 'contradicted';
    confidence: number;
    source: 'client_statement' | 'document' | 'lawyer_input';
    sourceRef: string | null;
    evidenceQuote?: string | null;
    llmCallId?: string | null;
  }): Promise<string>;
  setRiskFlag(args: {
    ruleKey: string;
    level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    label: string;
    detectedBy: 'rule' | 'rule+ai';
    sourceRef?: string | null;
    independentlyConfirmed?: boolean;
  }): Promise<string>;
  recordMetric(turnIndex: number, metrics: TurnMetrics): Promise<void>;
  logLlmCall(args: {
    purpose: 'conversation' | 'extraction' | 'urgency' | 'document' | 'summary';
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number | null;
    schemaValid?: boolean | null;
    repairAttempts?: number;
    promptTemplateKey?: string | null;
    promptVersion?: number | null;
  }): Promise<string>;
  updateProgress(args: {
    completeness?: number | null;
    /** De agent mag nooit ACCEPTED/REJECTED/REFERRED zetten; de RPC weigert dat. */
    status?: 'IN_PROGRESS' | 'READY_FOR_REVIEW' | 'NEEDS_HUMAN_CHECK' | null;
    subject?: string | null;
    clientName?: string | null;
    clientEmail?: string | null;
    clientPhone?: string | null;
  }): Promise<void>;
  endSession(
    endReason: 'completed' | 'client_left' | 'timeout' | 'error' | 'budget',
    billedSeconds?: number | null,
  ): Promise<void>;
}

export function createAgentRpc(
  client: AppClient,
  session: { sessionToken: string; intakeId: string },
): AgentRpc {
  const t = session.sessionToken;
  const id = session.intakeId;

  return {
    intakeId: id,

    context: () =>
      call<AgentContext>(client, 'agent_context', { p_session_token: t, p_intake_id: id }),

    setSessionProviders: (providers) =>
      call<void>(client, 'agent_set_session_providers', {
        p_session_token: t,
        p_intake_id: id,
        p_avatar_provider: providers.avatar,
        p_stt_provider: providers.stt,
        p_tts_provider: providers.tts,
        p_llm_model: providers.llmModel,
      }),

    appendMessage: (args) =>
      call<string>(client, 'agent_append_message', {
        p_session_token: t,
        p_intake_id: id,
        p_turn_index: args.turnIndex,
        p_role: args.role,
        p_content: args.content,
        p_intended_content: args.intendedContent ?? null,
        p_interrupted_at_char: args.interruptedAtChar ?? null,
        p_spoken_ms: args.spokenMs ?? null,
        p_planned_question_keys: args.plannedQuestionKeys ?? [],
        p_llm_call_id: args.llmCallId ?? null,
      }),

    upsertFact: (args) =>
      call<string>(client, 'agent_upsert_fact', {
        p_session_token: t,
        p_intake_id: id,
        p_key: args.key,
        p_value: args.value ?? null,
        p_value_type: args.valueType,
        p_status: args.status,
        p_confidence: args.confidence,
        p_source: args.source,
        p_source_ref: args.sourceRef,
        p_evidence_quote: args.evidenceQuote ?? null,
        p_llm_call_id: args.llmCallId ?? null,
      }),

    setRiskFlag: (args) =>
      call<string>(client, 'agent_set_risk_flag', {
        p_session_token: t,
        p_intake_id: id,
        p_rule_key: args.ruleKey,
        p_level: args.level,
        p_label: args.label,
        p_detected_by: args.detectedBy,
        p_source_ref: args.sourceRef ?? null,
        p_independently_confirmed: args.independentlyConfirmed ?? false,
      }),

    recordMetric: (turnIndex, metrics) =>
      call<void>(client, 'agent_record_metric', {
        p_session_token: t,
        p_intake_id: id,
        p_turn_index: turnIndex,
        p_metrics: metrics,
      }),

    logLlmCall: (args) =>
      call<string>(client, 'agent_log_llm_call', {
        p_session_token: t,
        p_intake_id: id,
        p_purpose: args.purpose,
        p_model: args.model,
        p_input_tokens: args.inputTokens,
        p_output_tokens: args.outputTokens,
        p_latency_ms: args.latencyMs,
        p_schema_valid: args.schemaValid ?? null,
        p_repair_attempts: args.repairAttempts ?? 0,
        p_prompt_template_key: args.promptTemplateKey ?? null,
        p_prompt_version: args.promptVersion ?? null,
      }),

    updateProgress: (args) =>
      call<void>(client, 'agent_update_progress', {
        p_session_token: t,
        p_intake_id: id,
        p_completeness: args.completeness ?? null,
        p_status: args.status ?? null,
        p_subject: args.subject ?? null,
        p_client_name: args.clientName ?? null,
        p_client_email: args.clientEmail ?? null,
        p_client_phone: args.clientPhone ?? null,
      }),

    endSession: (endReason, billedSeconds) =>
      call<void>(client, 'agent_end_session', {
        p_session_token: t,
        p_intake_id: id,
        p_end_reason: endReason,
        p_billed_seconds: billedSeconds ?? null,
      }),
  };
}
