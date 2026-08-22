-- =============================================================================
-- 0600  RPC-oppervlak
-- =============================================================================
-- Twee groepen aanroepers die géén org-lidmaatschap hebben en dus door elke
-- RLS-policy worden afgewezen:
--
--   * anon        — de publieke intakeroute, mag exact één intake aanmaken
--   * agent-token — de langlevende worker, mag exact één intake beschrijven
--
-- Beide krijgen hun rechten uitsluitend via de functies hieronder. Dat is de
-- mitigatie voor het grootste RLS-omzeilingsrisico in dit project: een langlevend
-- proces met een service-role key kan bij elke tenant, dus dat proces krijgt die key
-- niet (§4). Elke functie hieronder controleert expliciet dat de aanroeper binnen
-- zijn eigen intake blijft.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Guard
-- -----------------------------------------------------------------------------
create or replace function app.assert_agent_scope(p_intake_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if not app.is_agent_token() then
    raise exception 'geen geldig agent-token' using errcode = '42501';
  end if;

  if app.session_intake_id() is distinct from p_intake_id then
    raise exception 'agent-token is niet gebonden aan deze intake' using errcode = '42501';
  end if;

  select i.organization_id into v_org
  from public.intakes i
  where i.id = p_intake_id and i.deleted_at is null;

  if v_org is null then
    raise exception 'intake bestaat niet' using errcode = 'P0002';
  end if;

  return v_org;
end;
$$;

-- =============================================================================
-- Publieke intakeroute
-- =============================================================================

-- Rate limiting per IP-hash én per organisatie. Elke sessie kost geld vanaf de
-- eerste seconde, dus dit is een kostenmaatregel, geen hygiëne.
create or replace function app.check_and_bump_rate_limit(
  p_organization_id uuid,
  p_ip_hash         text,
  p_max_per_hour    int default 5
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts int;
begin
  insert into public.intake_rate_limits (organization_id, ip_hash, window_start, attempts)
  values (p_organization_id, p_ip_hash, date_trunc('hour', now()), 1)
  on conflict (organization_id, ip_hash, window_start)
    do update set attempts = public.intake_rate_limits.attempts + 1
  returning attempts into v_attempts;

  return v_attempts <= p_max_per_hour;
end;
$$;

-- Maakt de intake plus het consentrecord in één transactie aan.
-- Consent en intake horen bij elkaar: een intake zonder vastgelegde toestemming mag
-- niet kunnen bestaan, ook niet een halve seconde lang.
create or replace function app.create_public_intake(
  p_org_slug               text,
  p_language               text,
  p_channel                text,
  p_ip_hash                text,
  p_privacy_accepted       boolean,
  p_privacy_policy_version text,
  p_ai_disclosure_accepted boolean,
  p_ai_disclosure_version  text,
  p_camera_consent         boolean,
  p_microphone_consent     boolean,
  p_user_agent_hash        text default null
)
returns table (intake_id uuid, organization_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_intake_id uuid;
begin
  if not p_privacy_accepted or not p_ai_disclosure_accepted then
    raise exception 'privacyverklaring en AI-disclosure moeten beide zijn geaccepteerd'
      using errcode = '22023';
  end if;

  -- Microfoon is de enige harde eis: de intake moet volledig werken met alleen
  -- microfoon, camera is optioneel (§8, scherm 2).
  if not p_microphone_consent and p_channel <> 'chat' then
    raise exception 'microfoontoestemming is vereist voor een gesproken intake'
      using errcode = '22023';
  end if;

  select * into v_org
  from public.organizations o
  where o.slug = p_org_slug and o.is_active and o.deleted_at is null;

  if v_org.id is null then
    raise exception 'onbekende organisatie' using errcode = 'P0002';
  end if;

  if not app.check_and_bump_rate_limit(v_org.id, p_ip_hash) then
    raise exception 'te veel intakepogingen; probeer het later opnieuw'
      using errcode = '53400';
  end if;

  insert into public.intakes (organization_id, language, status, practice_area)
  values (v_org.id, coalesce(p_language, v_org.default_language), 'NEW', 'employment')
  returning id into v_intake_id;

  insert into public.consent_records (
    organization_id, intake_id,
    privacy_accepted, privacy_policy_version,
    ai_disclosure_accepted, ai_disclosure_version,
    camera_consent, microphone_consent, recording_consent,
    user_agent_hash
  )
  values (
    v_org.id, v_intake_id,
    p_privacy_accepted, p_privacy_policy_version,
    p_ai_disclosure_accepted, p_ai_disclosure_version,
    p_camera_consent, p_microphone_consent, false,
    p_user_agent_hash
  );

  insert into public.audit_log (organization_id, action, actor_type, entity_type, entity_id, intake_id)
  values (v_org.id, 'intake.created', 'client', 'intake', v_intake_id, v_intake_id);

  insert into public.audit_log (organization_id, action, actor_type, entity_type, entity_id, intake_id)
  values (v_org.id, 'consent.recorded', 'client', 'consent_record', v_intake_id, v_intake_id);

  return query select v_intake_id, v_org.id;
end;
$$;

-- =============================================================================
-- Agent-oppervlak
-- =============================================================================

create or replace function app.agent_start_session(
  p_intake_id       uuid,
  p_channel         text,
  p_room_name       text,
  p_avatar_provider text,
  p_stt_provider    text,
  p_tts_provider    text,
  p_llm_model       text,
  p_prewarmed_at    timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.assert_agent_scope(p_intake_id);
  v_limits jsonb;
  v_max_concurrent int;
  v_active int;
  v_session_id uuid;
begin
  select coalesce(o.session_limits, '{}'::jsonb) into v_limits
  from public.organizations o where o.id = v_org;

  v_max_concurrent := coalesce((v_limits ->> 'maxConcurrentSessions')::int, 5);

  select count(*) into v_active
  from public.sessions s
  where s.organization_id = v_org and s.ended_at is null;

  if v_active >= v_max_concurrent then
    raise exception 'maximum aantal gelijktijdige sessies bereikt' using errcode = '53400';
  end if;

  insert into public.sessions (
    organization_id, intake_id, channel, room_name,
    avatar_provider, stt_provider, tts_provider, llm_model, prewarmed_at
  )
  values (
    v_org, p_intake_id, p_channel, p_room_name,
    p_avatar_provider, p_stt_provider, p_tts_provider, p_llm_model, p_prewarmed_at
  )
  returning id into v_session_id;

  update public.intakes
     set status = case when status = 'NEW' then 'IN_PROGRESS' else status end
   where id = p_intake_id;

  insert into public.audit_log (organization_id, action, actor_type, entity_type, entity_id, intake_id)
  values (v_org, 'session.started', 'agent', 'session', v_session_id, p_intake_id);

  return v_session_id;
end;
$$;

create or replace function app.agent_end_session(
  p_intake_id      uuid,
  p_session_id     uuid,
  p_end_reason     text,
  p_billed_seconds int default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.assert_agent_scope(p_intake_id);
begin
  update public.sessions
     set ended_at = now(), end_reason = p_end_reason, billed_seconds = p_billed_seconds
   where id = p_session_id and intake_id = p_intake_id;

  if not found then
    raise exception 'sessie hoort niet bij deze intake' using errcode = '42501';
  end if;

  insert into public.audit_log (organization_id, action, actor_type, entity_type, entity_id, intake_id, metadata)
  values (v_org, 'session.ended', 'agent', 'session', p_session_id, p_intake_id,
          jsonb_build_object('end_reason', p_end_reason));
end;
$$;

-- Het transcript. `p_content` is wat de cliënt HEEFT GEHOORD; `p_intended_content`
-- wat het model wilde zeggen. Bij een barge-in verschillen die twee.
create or replace function app.agent_append_message(
  p_intake_id            uuid,
  p_session_id           uuid,
  p_turn_index           int,
  p_role                 text,
  p_content              text,
  p_intended_content     text default null,
  p_interrupted_at_char  int default null,
  p_spoken_ms            int default null,
  p_planned_question_keys text[] default '{}',
  p_llm_call_id          uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.assert_agent_scope(p_intake_id);
  v_id uuid;
begin
  insert into public.messages (
    organization_id, intake_id, session_id, turn_index, role,
    content, intended_content, interrupted_at_char, spoken_ms,
    planned_question_keys, llm_call_id
  )
  values (
    v_org, p_intake_id, p_session_id, p_turn_index, p_role,
    p_content, p_intended_content, p_interrupted_at_char, p_spoken_ms,
    coalesce(p_planned_question_keys, '{}'), p_llm_call_id
  )
  returning id into v_id;

  update public.intakes
     set turn_count = greatest(turn_count, p_turn_index + 1)
   where id = p_intake_id;

  return v_id;
end;
$$;

create or replace function app.agent_upsert_fact(
  p_intake_id     uuid,
  p_key           text,
  p_value         jsonb,
  p_value_type    text,
  p_status        text,
  p_confidence    numeric,
  p_source        text,
  p_source_ref    text,
  p_evidence_quote text default null,
  p_llm_call_id   uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.assert_agent_scope(p_intake_id);
  v_id uuid;
begin
  insert into public.case_facts (
    organization_id, intake_id, key, value, value_type,
    status, confidence, source, source_ref, evidence_quote, llm_call_id
  )
  values (
    v_org, p_intake_id, p_key, p_value, p_value_type,
    p_status, p_confidence, p_source, p_source_ref, p_evidence_quote, p_llm_call_id
  )
  on conflict (intake_id, key) do update set
    -- Een bestaand confirmed feit wordt niet overschreven door een zwakkere
    -- observatie. Tegenspraak wordt vastgelegd als 'contradicted', niet stilzwijgend
    -- weggeschreven: de advocaat moet zien dat de cliënt zichzelf tegensprak.
    value          = case
                       when public.case_facts.status = 'confirmed' and excluded.status <> 'confirmed'
                       then public.case_facts.value else excluded.value end,
    status         = case
                       when public.case_facts.status = 'confirmed'
                            and excluded.status = 'confirmed'
                            and public.case_facts.value is distinct from excluded.value
                       then 'contradicted'
                       when public.case_facts.status = 'confirmed' and excluded.status <> 'confirmed'
                       then public.case_facts.status
                       else excluded.status end,
    confidence     = greatest(public.case_facts.confidence, excluded.confidence),
    source         = excluded.source,
    source_ref     = coalesce(excluded.source_ref, public.case_facts.source_ref),
    evidence_quote = coalesce(excluded.evidence_quote, public.case_facts.evidence_quote),
    llm_call_id    = coalesce(excluded.llm_call_id, public.case_facts.llm_call_id),
    updated_at     = now()
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function app.agent_set_risk_flag(
  p_intake_id  uuid,
  p_rule_key   text,
  p_level      text,
  p_label      text,
  p_detected_by text,
  p_source_ref text default null,
  p_independently_confirmed boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.assert_agent_scope(p_intake_id);
  v_id uuid;
begin
  insert into public.risk_flags (
    organization_id, intake_id, rule_key, level, label,
    detected_by, source_ref, independently_confirmed
  )
  values (v_org, p_intake_id, p_rule_key, p_level, p_label,
          p_detected_by, p_source_ref, p_independently_confirmed)
  on conflict (intake_id, rule_key) do update set
    level = excluded.level,
    label = excluded.label,
    detected_by = excluded.detected_by,
    independently_confirmed = public.risk_flags.independently_confirmed
                              or excluded.independently_confirmed
  returning id into v_id;

  -- Het hoogste openstaande niveau bepaalt de urgentie van de intake.
  update public.intakes i
     set urgency_level = (
       select f.level from public.risk_flags f
       where f.intake_id = p_intake_id and f.resolved_at is null
       order by case f.level
                  when 'CRITICAL' then 3 when 'HIGH' then 2
                  when 'MEDIUM' then 1 else 0 end desc
       limit 1
     )
   where i.id = p_intake_id;

  return v_id;
end;
$$;

create or replace function app.agent_record_metric(
  p_intake_id  uuid,
  p_session_id uuid,
  p_turn_index int,
  p_metrics    jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_agent_scope(p_intake_id);

  insert into public.session_metrics (
    session_id, turn_index,
    speech_end_to_stt_final_ms, stt_to_llm_first_token_ms,
    llm_to_tts_first_audio_ms, tts_to_avatar_first_frame_ms,
    total_response_latency_ms, interrupt_to_silence_ms, was_interrupted
  )
  select
    p_session_id, p_turn_index,
    (p_metrics ->> 'speechEndToSttFinalMs')::int,
    (p_metrics ->> 'sttToLlmFirstTokenMs')::int,
    (p_metrics ->> 'llmToTtsFirstAudioMs')::int,
    (p_metrics ->> 'ttsToAvatarFirstFrameMs')::int,
    (p_metrics ->> 'totalResponseLatencyMs')::int,
    (p_metrics ->> 'interruptToSilenceMs')::int,
    coalesce((p_metrics ->> 'wasInterrupted')::boolean, false)
  where exists (
    select 1 from public.sessions s
    where s.id = p_session_id and s.intake_id = p_intake_id
  )
  on conflict (session_id, turn_index) do update set
    speech_end_to_stt_final_ms   = excluded.speech_end_to_stt_final_ms,
    stt_to_llm_first_token_ms    = excluded.stt_to_llm_first_token_ms,
    llm_to_tts_first_audio_ms    = excluded.llm_to_tts_first_audio_ms,
    tts_to_avatar_first_frame_ms = excluded.tts_to_avatar_first_frame_ms,
    total_response_latency_ms    = excluded.total_response_latency_ms,
    interrupt_to_silence_ms      = excluded.interrupt_to_silence_ms,
    was_interrupted              = excluded.was_interrupted;
end;
$$;

create or replace function app.agent_log_llm_call(
  p_intake_id  uuid,
  p_session_id uuid,
  p_purpose    text,
  p_model      text,
  p_input_tokens int,
  p_output_tokens int,
  p_latency_ms int,
  p_schema_valid boolean default null,
  p_repair_attempts int default 0,
  p_prompt_template_key text default null,
  p_prompt_version int default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.assert_agent_scope(p_intake_id);
  v_template_id uuid;
  v_id uuid;
begin
  if p_prompt_template_key is not null then
    select t.id into v_template_id
    from public.prompt_templates t where t.key = p_prompt_template_key;
  end if;

  insert into public.llm_calls (
    organization_id, intake_id, session_id, purpose, model,
    prompt_template_id, prompt_version,
    input_tokens, output_tokens, latency_ms, schema_valid, repair_attempts
  )
  values (
    v_org, p_intake_id, p_session_id, p_purpose, p_model,
    v_template_id, p_prompt_version,
    p_input_tokens, p_output_tokens, p_latency_ms, p_schema_valid, coalesce(p_repair_attempts, 0)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function app.agent_update_progress(
  p_intake_id    uuid,
  p_completeness numeric default null,
  p_status       text default null,
  p_subject      text default null,
  p_client_name  text default null,
  p_client_email text default null,
  p_client_phone text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_agent_scope(p_intake_id);

  -- De AI beslist nooit over acceptatie (§6). Deze functie mag de status hoogstens
  -- naar READY_FOR_REVIEW brengen; ACCEPTED/REJECTED/REFERRED zijn menselijke acties.
  if p_status is not null and p_status not in ('IN_PROGRESS','READY_FOR_REVIEW','NEEDS_HUMAN_CHECK') then
    raise exception 'de agent mag deze status niet zetten: %', p_status using errcode = '42501';
  end if;

  update public.intakes
     set completeness = coalesce(p_completeness, completeness),
         status       = coalesce(p_status, status),
         subject      = coalesce(p_subject, subject),
         client_name  = coalesce(p_client_name, client_name),
         client_email = coalesce(p_client_email, client_email),
         client_phone = coalesce(p_client_phone, client_phone),
         completed_at = case when p_status = 'READY_FOR_REVIEW' then now() else completed_at end
   where id = p_intake_id;
end;
$$;

-- De agent leest zijn eigen context: organisatieconfiguratie, feiten, transcript en
-- openstaande advocaatverzoeken. Eén call in plaats van vier, en geen tabeltoegang.
create or replace function app.agent_context(p_intake_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := app.assert_agent_scope(p_intake_id);
  v_result jsonb;
begin
  select jsonb_build_object(
    'intake', (
      select to_jsonb(x) from (
        select i.id, i.language, i.practice_area, i.status, i.turn_count,
               i.completeness, i.template_key, i.template_version
        from public.intakes i where i.id = p_intake_id
      ) x
    ),
    'organization', (
      select to_jsonb(x) from (
        select o.id, o.slug, o.name, o.default_language, o.provider_config,
               o.session_limits, o.intake_criteria, o.publish_client_video
        from public.organizations o where o.id = v_org
      ) x
    ),
    'facts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'key', f.key, 'value', f.value, 'valueType', f.value_type,
        'status', f.status, 'confidence', f.confidence,
        'source', f.source, 'sourceRef', f.source_ref
      ) order by f.key)
      from public.case_facts f where f.intake_id = p_intake_id
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'role', m.role, 'content', m.content,
        'interruptedAtChar', m.interrupted_at_char,
        'plannedQuestionKeys', m.planned_question_keys,
        'createdAt', m.created_at
      ) order by m.turn_index)
      from public.messages m where m.intake_id = p_intake_id
    ), '[]'::jsonb),
    'pendingLawyerRequests', coalesce((
      select jsonb_agg(r.body order by r.created_at)
      from public.lawyer_requests r
      where r.intake_id = p_intake_id and r.status = 'open'
    ), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'filename', d.filename, 'analysisStatus', d.analysis_status,
        'summary', a.short_summary, 'confidence', a.confidence
      ) order by d.uploaded_at)
      from public.documents d
      left join public.document_analysis a on a.document_id = d.id
      where d.intake_id = p_intake_id and d.deleted_at is null
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- =============================================================================
-- Rechten
-- =============================================================================
-- Standaard mag niemand iets; hieronder staat precies wie wat mag aanroepen.

revoke all on function app.assert_agent_scope(uuid) from public;
revoke all on function app.check_and_bump_rate_limit(uuid, text, int) from public;

revoke all on function app.create_public_intake(text, text, text, text, boolean, text, boolean, text, boolean, boolean, text) from public;
grant execute on function app.create_public_intake(text, text, text, text, boolean, text, boolean, text, boolean, boolean, text) to anon, authenticated;

-- Het agent-token draagt role `authenticated`; de guard binnen elke functie doet het
-- echte werk. Een gewone ingelogde gebruiker mist de claim `token_type` en krijgt
-- daarom 42501 terug, ook al mag hij de functie aanroepen.
grant execute on function app.agent_start_session(uuid, text, text, text, text, text, text, timestamptz) to authenticated;
grant execute on function app.agent_end_session(uuid, uuid, text, int) to authenticated;
grant execute on function app.agent_append_message(uuid, uuid, int, text, text, text, int, int, text[], uuid) to authenticated;
grant execute on function app.agent_upsert_fact(uuid, text, jsonb, text, text, numeric, text, text, text, uuid) to authenticated;
grant execute on function app.agent_set_risk_flag(uuid, text, text, text, text, text, boolean) to authenticated;
grant execute on function app.agent_record_metric(uuid, uuid, int, jsonb) to authenticated;
grant execute on function app.agent_log_llm_call(uuid, uuid, text, text, int, int, int, boolean, int, text, int) to authenticated;
grant execute on function app.agent_update_progress(uuid, numeric, text, text, text, text, text) to authenticated;
grant execute on function app.agent_context(uuid) to authenticated;
