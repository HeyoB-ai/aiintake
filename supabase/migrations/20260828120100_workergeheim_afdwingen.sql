-- =============================================================================
-- 20260828120100  Het workergeheim afdwingen (deel 2 van 2)
-- =============================================================================
--
-- LET OP — push deze migratie pas als aan alle drie is voldaan:
--
--   1. 20260828120000 staat op de database
--   2. het geheim is gezet (`node scripts/set-worker-secret.mjs`)
--   3. de worker draait met AGENT_WORKER_SECRET en meldt bij het opstarten
--      "workergeheim: herkend"
--
-- Vanaf deze migratie weigert de database elke agent-schrijfactie zonder geldig
-- workergeheim. Wordt hij te vroeg gepusht, dan ligt de dienst stil — midden in
-- lopende gesprekken, met mislukte feitschrijvingen als enige symptoom.
--
-- Zie RISICOS.md risico 31 en de kop van 20260828120000 voor het waarom.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- De volgorde afdwingen in plaats van hem opschrijven
-- -----------------------------------------------------------------------------
-- `supabase db push` past alle openstaande migraties in één keer toe. De volgorde
-- hierboven zou dus goedbedoeld advies zijn dat niemand kan volgen: 20260828120000 en
-- deze migratie zouden samen binnenkomen, en de dienst ligt stil tot de worker het
-- geheim heeft.
--
-- Vandaar deze controle. Staat er nog geen actief workergeheim, dan breekt deze migratie
-- af. De vorige is dan wél toegepast — Supabase draait ze op volgorde, elk in een eigen
-- transactie — dus je hebt precies stap 1 gedaan en niets meer. Zet het geheim, rol de
-- worker uit, en draai `db push` opnieuw.
--
-- Een toelichting is geen bewaker; dit wel.
do $$
begin
  if not exists (select 1 from app.worker_credentials where retired_at is null) then
    raise exception 'er is nog geen actief workergeheim'
      using hint =
        'Stap 1 (20260828120000) is nu toegepast. Draai node scripts/set-worker-secret.mjs, '
        'zet AGENT_WORKER_SECRET bij de worker, rol uit, controleer op '
        '"workergeheim: herkend", en draai daarna db push opnieuw. Zonder die volgorde '
        'weigert de database elke schrijfactie van de worker.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- De tweede factor
-- -----------------------------------------------------------------------------
-- Het sessietoken bewijst wélke intake; het workergeheim bewijst dát je de worker bent.
-- De browser van de cliënt heeft de eerste en niet de tweede, en geen van beide volstaat
-- alleen.
--
-- De volgorde van de controles is niet willekeurig. Het workergeheim gaat vóór het
-- token: wie geen worker is, hoeft niet te horen of zijn token klopt. Dat scheelt ook
-- een hashberekening op elk verzoek van iemand die er niets te zoeken heeft.
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
  -- De tweede factor. Zie RISICOS.md risico 31.
  if not app.worker_herkend() then
    raise exception 'geen geldig agent-token' using errcode = '42501';
  end if;

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

-- Dezelfde foutmelding als bij een ongeldig token, en dat is opzet: het antwoord op
-- "mag ik hier schrijven" hoort niet te verklappen wélke helft ontbrak.
comment on function app.assert_agent_scope(text, uuid) is
  'Twee factoren: het workergeheim (header) en het sessietoken (parameter). Risico 31.';

-- =============================================================================
-- written_by vullen
-- =============================================================================
-- Alleen deze twee functies schrijven rijen waarvan de herkomst later ter discussie kan
-- staan: een transcriptregel en een feit. De waarde staat hier hard op 'agent' en komt
-- niet uit een parameter — na `assert_agent_scope` is per definitie vastgesteld dat de
-- aanroeper het workergeheim heeft.

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
  p_llm_call_id           uuid default null,
  p_client_utterance_was_cut boolean default false,
  p_continuation_gap_ms   int default null
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
    planned_question_keys, llm_call_id,
    client_utterance_was_cut, continuation_gap_ms, written_by
  )
  values (
    v_org, p_intake_id, v_session, p_turn_index, p_role,
    p_content, p_intended_content, p_interrupted_at_char, p_spoken_ms,
    coalesce(p_planned_question_keys, '{}'), p_llm_call_id,
    coalesce(p_client_utterance_was_cut, false), p_continuation_gap_ms, 'agent'
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
    status, confidence, source, source_ref, evidence_quote, llm_call_id, written_by
  )
  values (
    v_org, p_intake_id, p_key, p_value, p_value_type,
    p_status, p_confidence, p_source, p_source_ref, p_evidence_quote, p_llm_call_id, 'agent'
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
    -- Ook bij een update: deze rij is nu door de worker aangeraakt. Een rij die vóór
    -- risico 31 op 'unknown' stond en daarna is bijgewerkt, is vanaf dat moment wél
    -- verantwoord — voor de waarde die er dan staat.
    written_by     = 'agent',
    updated_at     = now()
  returning id into v_id;

  return v_id;
end;
$$;
