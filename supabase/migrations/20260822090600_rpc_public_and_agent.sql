-- =============================================================================
-- 0600  RPC-oppervlak
-- =============================================================================
-- Twee groepen aanroepers die géén org-lidmaatschap hebben en dus door elke
-- RLS-policy worden afgewezen:
--
--   * de publieke intakeroute — mag exact één intake aanmaken
--   * de agent-worker         — mag exact één intake beschrijven
--
-- Beide draaien op de publishable key (databaserol `anon`) en krijgen hun rechten
-- uitsluitend via de functies hieronder. Dat is de mitigatie voor het grootste
-- RLS-omzeilingsrisico in dit project: een langlevend proces met een sleutel die bij
-- elke tenant kan, dus krijgt dat proces zo'n sleutel niet.
--
-- De worker legitimeert zich met een ondoorzichtig sessietoken dat als expliciete
-- parameter meekomt en met een lookup in public.session_tokens wordt geverifieerd.
-- Niet als bearer token in de Authorization-header: bij asymmetrische JWT signing
-- keys verifieert PostgREST daar tegen de JWKS van het project, en de private key
-- daarvan zit in Supabase Auth. Zie docs/ADR-0007-agent-sessietoken.md.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tokenverificatie
-- -----------------------------------------------------------------------------

create or replace function app.hash_session_token(p_token text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

-- De guard. Elke agent-functie begint hiermee; wijkt er één af, dan faalt de test
-- packages/db/src/__tests__/schema-parity.test.ts.
--
-- Vier redenen om te weigeren, allemaal met dezelfde melding naar buiten: onbekend,
-- verlopen, ingetrokken, of geldig maar voor een andere intake. Het onderscheid staat
-- wel in de foutmelding van de laatste, omdat dat een programmeerfout in de worker is
-- en geen aanval — de andere drie zijn niet te onderscheiden voor de aanroeper.
create or replace function app.assert_agent_scope(
  p_session_token text,
  p_intake_id     uuid
)
returns table (organization_id uuid, session_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_token public.session_tokens%rowtype;
begin
  -- Goedkope afwijzing vóór we gaan hashen. Het echte token is 43 tekens base64url.
  if p_session_token is null or length(p_session_token) not between 20 and 200 then
    raise exception 'geen geldig agent-token' using errcode = '42501';
  end if;

  select * into v_token
  from public.session_tokens t
  where t.token_hash = app.hash_session_token(p_session_token)
    and t.revoked_at is null
    and t.expires_at > now();

  if v_token.id is null then
    -- Onbekend, verlopen of ingetrokken. Bewust niet uitgesplitst: dat verschil
    -- vertelt iemand die tokens raadt of hij warm is.
    raise exception 'geen geldig agent-token' using errcode = '42501';
  end if;

  if v_token.intake_id is distinct from p_intake_id then
    raise exception 'agent-token is niet gebonden aan deze intake' using errcode = '42501';
  end if;

  -- Grofmazig bijwerken: hooguit eens per minuut een schrijfactie, zodat de hele
  -- beurtcyclus niet op één rij gaat zitten duwen.
  if v_token.last_used_at is null or v_token.last_used_at < now() - interval '1 minute' then
    update public.session_tokens set last_used_at = now() where id = v_token.id;
  end if;

  organization_id := v_token.organization_id;
  session_id := v_token.session_id;
  return next;
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
create or replace function public.create_public_intake(
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
-- Uitgifte en intrekking — alleen voor apps/web (secret key)
-- =============================================================================

-- Maakt de sessie en het bijbehorende token in één transactie.
--
-- Dit is bewust géén taak van de worker: wie zijn eigen credential mag aanmaken,
-- heeft er geen aan. De web-app genereert het ruwe token, stuurt alleen de hash
-- hierheen, en geeft het ruwe token door aan de worker. Deze database ziet het ruwe
-- token nooit.
create or replace function public.issue_agent_session(
  p_intake_id     uuid,
  p_channel       text,
  p_token_hash    text,
  p_ttl_minutes   int,
  p_room_name     text default null,
  p_prewarmed_at  timestamptz default null
)
returns table (session_id uuid, organization_id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_limits jsonb;
  v_max_concurrent int;
  v_max_minutes int;
  v_active int;
  v_session_id uuid;
  v_expires timestamptz;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'token_hash moet een hex-gecodeerde SHA-256 zijn' using errcode = '22023';
  end if;

  -- Een TTL van nul of negatief zou een token opleveren dat al verlopen geboren
  -- wordt. Dat is geen zinnige aanroep, dus geen stille afronding maar een fout.
  if p_ttl_minutes is not null and p_ttl_minutes < 1 then
    raise exception 'ttl_minutes moet minimaal 1 zijn' using errcode = '22023';
  end if;

  select i.organization_id into v_org
  from public.intakes i
  where i.id = p_intake_id and i.deleted_at is null;

  if v_org is null then
    raise exception 'intake bestaat niet' using errcode = 'P0002';
  end if;

  select coalesce(o.session_limits, '{}'::jsonb) into v_limits
  from public.organizations o where o.id = v_org;

  v_max_concurrent := coalesce((v_limits ->> 'maxConcurrentSessions')::int, 5);
  v_max_minutes := coalesce((v_limits ->> 'maxSessionMinutes')::int, 25);

  select count(*) into v_active
  from public.sessions s
  where s.organization_id = v_org and s.ended_at is null;

  if v_active >= v_max_concurrent then
    raise exception 'maximum aantal gelijktijdige sessies bereikt' using errcode = '53400';
  end if;

  -- De TTL is de sessieduur plus wat marge, en nooit meer dan het kantoor toestaat.
  -- Een token dat langer leeft dan de sessie is precies wat we niet willen.
  v_expires := now() + (least(coalesce(p_ttl_minutes, v_max_minutes + 5),
                              v_max_minutes + 5) * interval '1 minute');

  insert into public.sessions (organization_id, intake_id, channel, room_name, prewarmed_at)
  values (v_org, p_intake_id, p_channel, p_room_name, p_prewarmed_at)
  returning id into v_session_id;

  insert into public.session_tokens (
    organization_id, intake_id, session_id, token_hash, expires_at
  )
  values (v_org, p_intake_id, v_session_id, p_token_hash, v_expires);

  update public.intakes
     set status = case when status = 'NEW' then 'IN_PROGRESS' else status end
   where id = p_intake_id;

  insert into public.audit_log (organization_id, action, actor_type, entity_type, entity_id, intake_id)
  values (v_org, 'session.started', 'system', 'session', v_session_id, p_intake_id);

  return query select v_session_id, v_org, v_expires;
end;
$$;

-- Intrekken zonder de sessie te beëindigen: voor het geval een token is gelekt of een
-- worker vastloopt. Dit is wat een JWT niet kan.
create or replace function public.revoke_agent_session(p_session_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.session_tokens
     set revoked_at = now()
   where session_id = p_session_id and revoked_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Opruimen van verlopen tokens. Aanroepen vanuit de retentie-cleanup (Fase 6).
-- Verlopen tokens zijn al onbruikbaar; dit houdt de tabel alleen klein.
create or replace function public.purge_expired_session_tokens(p_older_than interval default interval '7 days')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  delete from public.session_tokens
   where expires_at < now() - p_older_than;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- =============================================================================
-- Agent-oppervlak
-- =============================================================================
-- Elke functie neemt het sessietoken als eerste parameter en leidt de sessie eruit
-- af. Er is bewust geen `p_session_id`-parameter meer: het token bepaalt zowel de
-- intake als de sessie, dus een mismatch tussen die twee kan niet meer bestaan.

create or replace function public.agent_set_session_providers(
  p_session_token   text,
  p_intake_id       uuid,
  p_avatar_provider text,
  p_stt_provider    text,
  p_tts_provider    text,
  p_llm_model       text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

  -- Wat de worker daadwerkelijk gebruikt heeft, niet wat er gepland was: na een
  -- fallback van avatar naar audio-only moet de kostenanalyse kloppen.
  update public.sessions
     set avatar_provider = p_avatar_provider,
         stt_provider    = p_stt_provider,
         tts_provider    = p_tts_provider,
         llm_model       = p_llm_model
   where id = v_session;
end;
$$;

create or replace function public.agent_end_session(
  p_session_token  text,
  p_intake_id      uuid,
  p_end_reason     text,
  p_billed_seconds int default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

  update public.sessions
     set ended_at = now(), end_reason = p_end_reason, billed_seconds = p_billed_seconds
   where id = v_session;

  -- Sessie voorbij, token dood. Niet wachten tot expires_at: de meeste sessies
  -- eindigen ruim vóór hun TTL, en dat gat is precies waar een gelekt token nog
  -- bruikbaar zou zijn.
  update public.session_tokens
     set revoked_at = now()
   where session_id = v_session and revoked_at is null;

  insert into public.audit_log (organization_id, action, actor_type, entity_type, entity_id, intake_id, metadata)
  values (v_org, 'session.ended', 'agent', 'session', v_session, p_intake_id,
          jsonb_build_object('end_reason', p_end_reason));
end;
$$;

-- Het transcript. `p_content` is wat de cliënt HEEFT GEHOORD; `p_intended_content`
-- wat het model wilde zeggen. Bij een barge-in verschillen die twee.
create or replace function public.agent_append_message(
  p_session_token         text,
  p_intake_id             uuid,
  p_turn_index            int,
  p_role                  text,
  p_content               text,
  p_intended_content      text default null,
  p_interrupted_at_char   int default null,
  p_spoken_ms             int default null,
  p_planned_question_keys text[] default '{}',
  p_llm_call_id           uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
  v_id uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

  insert into public.messages (
    organization_id, intake_id, session_id, turn_index, role,
    content, intended_content, interrupted_at_char, spoken_ms,
    planned_question_keys, llm_call_id
  )
  values (
    v_org, p_intake_id, v_session, p_turn_index, p_role,
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

create or replace function public.agent_upsert_fact(
  p_session_token  text,
  p_intake_id      uuid,
  p_key            text,
  p_value          jsonb,
  p_value_type     text,
  p_status         text,
  p_confidence     numeric,
  p_source         text,
  p_source_ref     text,
  p_evidence_quote text default null,
  p_llm_call_id    uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
  v_id uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

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

create or replace function public.agent_set_risk_flag(
  p_session_token           text,
  p_intake_id               uuid,
  p_rule_key                text,
  p_level                   text,
  p_label                   text,
  p_detected_by             text,
  p_source_ref              text default null,
  p_independently_confirmed boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
  v_id uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

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

create or replace function public.agent_record_metric(
  p_session_token text,
  p_intake_id     uuid,
  p_turn_index    int,
  p_metrics       jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

  insert into public.session_metrics (
    session_id, turn_index,
    speech_end_to_stt_final_ms, stt_to_llm_first_token_ms,
    llm_to_tts_first_audio_ms, tts_to_avatar_first_frame_ms,
    total_response_latency_ms, interrupt_to_silence_ms, was_interrupted
  )
  values (
    v_session, p_turn_index,
    (p_metrics ->> 'speechEndToSttFinalMs')::int,
    (p_metrics ->> 'sttToLlmFirstTokenMs')::int,
    (p_metrics ->> 'llmToTtsFirstAudioMs')::int,
    (p_metrics ->> 'ttsToAvatarFirstFrameMs')::int,
    (p_metrics ->> 'totalResponseLatencyMs')::int,
    (p_metrics ->> 'interruptToSilenceMs')::int,
    coalesce((p_metrics ->> 'wasInterrupted')::boolean, false)
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

create or replace function public.agent_log_llm_call(
  p_session_token       text,
  p_intake_id           uuid,
  p_purpose             text,
  p_model               text,
  p_input_tokens        int,
  p_output_tokens       int,
  p_latency_ms          int,
  p_schema_valid        boolean default null,
  p_repair_attempts     int default 0,
  p_prompt_template_key text default null,
  p_prompt_version      int default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
  v_template_id uuid;
  v_id uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

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
    v_org, p_intake_id, v_session, p_purpose, p_model,
    v_template_id, p_prompt_version,
    p_input_tokens, p_output_tokens, p_latency_ms, p_schema_valid, coalesce(p_repair_attempts, 0)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.agent_update_progress(
  p_session_token text,
  p_intake_id     uuid,
  p_completeness  numeric default null,
  p_status        text default null,
  p_subject       text default null,
  p_client_name   text default null,
  p_client_email  text default null,
  p_client_phone  text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

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
create or replace function public.agent_context(
  p_session_token text,
  p_intake_id     uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
  v_result jsonb;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

  select jsonb_build_object(
    'sessionId', v_session,
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
-- Dit blok is het volledige API-oppervlak. Wat hier niet staat, is niet aanroepbaar.
--
-- De REVOKE vóór elke GRANT is geen bijgeloof. Twee defaults werken tegen ons:
--
--   1. Postgres geeft nieuwe functies EXECUTE aan PUBLIC.
--   2. Supabase zet `alter default privileges in schema public grant all on
--      functions to anon, authenticated, service_role`. Een nieuwe functie in
--      `public` is daardoor meteen door anon aan te roepen.
--
-- Alleen intrekken en dan gericht toekennen geeft een oppervlak dat je kunt lezen.
-- scripts/check-migrations.mjs vergelijkt de uitkomst met een allowlist en faalt
-- op elke functie die anon onbedoeld kan aanroepen.

-- Interne helpers. Ze leven in `app`, dat niet door PostgREST wordt geëxposeerd,
-- dus ze zijn sowieso niet over HTTP bereikbaar. De REVOKE is de tweede laag.
revoke all on function app.hash_session_token(text) from public;
revoke all on function app.assert_agent_scope(text, uuid) from public;
revoke all on function app.check_and_bump_rate_limit(uuid, text, int) from public;

-- Uitgifte en intrekking horen bij de web-app, die op de secret key draait.
-- De worker mag zijn eigen credential niet kunnen aanmaken of verlengen.
revoke all on function public.issue_agent_session(uuid, text, text, int, text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_agent_session(uuid, text, text, int, text, timestamptz) to service_role;
revoke all on function public.revoke_agent_session(uuid) from public, anon, authenticated;
grant execute on function public.revoke_agent_session(uuid) to service_role;
revoke all on function public.purge_expired_session_tokens(interval) from public, anon, authenticated;
grant execute on function public.purge_expired_session_tokens(interval) to service_role;

-- De publieke intakeroute.
revoke all on function public.create_public_intake(text, text, text, text, boolean, text, boolean, text, boolean, boolean, text) from public;
grant execute on function public.create_public_intake(text, text, text, text, boolean, text, boolean, text, boolean, boolean, text) to anon, authenticated;

-- Het agent-oppervlak. De worker draait op de publishable key en is dus `anon`.
-- `authenticated` staat er ook bij, zodat een ingelogde gebruiker die deze functies
-- probeert aan te roepen de duidelijke melding "geen geldig agent-token" krijgt in
-- plaats van een generieke permission denied. Veiliger wordt het er niet van en ook
-- niet minder: het token is de credential, niet de rol.
revoke all on function public.agent_set_session_providers(text, uuid, text, text, text, text) from public;
grant execute on function public.agent_set_session_providers(text, uuid, text, text, text, text) to anon, authenticated;
revoke all on function public.agent_end_session(text, uuid, text, int) from public;
grant execute on function public.agent_end_session(text, uuid, text, int) to anon, authenticated;
revoke all on function public.agent_append_message(text, uuid, int, text, text, text, int, int, text[], uuid) from public;
grant execute on function public.agent_append_message(text, uuid, int, text, text, text, int, int, text[], uuid) to anon, authenticated;
revoke all on function public.agent_upsert_fact(text, uuid, text, jsonb, text, text, numeric, text, text, text, uuid) from public;
grant execute on function public.agent_upsert_fact(text, uuid, text, jsonb, text, text, numeric, text, text, text, uuid) to anon, authenticated;
revoke all on function public.agent_set_risk_flag(text, uuid, text, text, text, text, text, boolean) from public;
grant execute on function public.agent_set_risk_flag(text, uuid, text, text, text, text, text, boolean) to anon, authenticated;
revoke all on function public.agent_record_metric(text, uuid, int, jsonb) from public;
grant execute on function public.agent_record_metric(text, uuid, int, jsonb) to anon, authenticated;
revoke all on function public.agent_log_llm_call(text, uuid, text, text, int, int, int, boolean, int, text, int) from public;
grant execute on function public.agent_log_llm_call(text, uuid, text, text, int, int, int, boolean, int, text, int) to anon, authenticated;
revoke all on function public.agent_update_progress(text, uuid, numeric, text, text, text, text, text) from public;
grant execute on function public.agent_update_progress(text, uuid, numeric, text, text, text, text, text) to anon, authenticated;
revoke all on function public.agent_context(text, uuid) from public;
grant execute on function public.agent_context(text, uuid) to anon, authenticated;
