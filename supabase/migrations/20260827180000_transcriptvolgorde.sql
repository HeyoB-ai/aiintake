-- De volgorde binnen een beurt lag niet vast.
--
-- ## Wat er misging
--
-- `persistTurn` schrijft per beurt twee rijen met dezelfde `turn_index`: eerst de
-- clientuitspraak, daarna het antwoord van de assistent. De query sorteerde alleen op
-- `turn_index`, en bij gelijke waarden mag Postgres elke volgorde teruggeven.
--
-- In de praktijk gaf hij consequent assistent voor client. Elk paar stond dus omgekeerd, en
-- dat leest als een assistent die een vraag stelt voordat het antwoord op de vorige binnen is:
--
--     18:18:46 ASSISTENT  "Kunt u dat spellen?"
--     18:18:46 U          "r-ov-c"
--
-- De opgeslagen rijen kloppen -- gemeten staat de client 50 ms voor de assistent -- maar wie
-- ze zo teruggeeft, keert het gesprek om.
--
-- ## Waarom dit een migratie is en niet alleen een schermreparatie
--
-- Deze RPC voedt de feitextractie bij een hervatting. Het model krijgt de geschiedenis als
-- dialoog, en in omgekeerde volgorde hoort "exclusief" bij de vraag die eronder staat in
-- plaats van bij het salaris erboven. Dan kan een feit aan de verkeerde vraag worden
-- gekoppeld, en dat is precies het soort fout dat in het dossier onzichtbaar is.
--
-- ## Waarom `created_at` en niet de rol
--
-- Een beurt kan drie rijen hebben: client, erkenning, en het eigenlijke antwoord -- die
-- laatste twee allebei `assistant`. Sorteren op rol laat die twee ongeordend. `created_at`
-- heeft microsecondenprecisie en elke append is een eigen transactie, dus de tijdstempels
-- verschillen gegarandeerd.

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
               i.completeness, i.template_key, i.template_version,
               -- Nieuw. Zie de toelichting boven deze functie.
               i.client_name
        from public.intakes i where i.id = p_intake_id
      ) x
    ),
    'organization', (
      select to_jsonb(x) from (
        select o.id, o.slug, o.name, o.default_language, o.provider_config,
               o.session_limits, o.intake_criteria, o.publish_client_video,
               -- Nieuw. De groet en het datumanker rekenen hierop.
               o.time_zone
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
            -- `created_at` erbij. Zonder tweede sleutel is de volgorde binnen een beurt
      -- ongedefinieerd, en gaf Postgres consequent de assistent vóór de client terug.
      ) order by m.turn_index, m.created_at)
      from public.messages m where m.intake_id = p_intake_id
    ), '[]'::jsonb),
    -- Óf de client contactgegevens heeft ingevuld, niet wélke.
    --
    -- De planner vroeg naar e-mail en telefoon terwijl de client ze op het
    -- toestemmingsscherm had ingetypt. De waarden zelf blijven bewust buiten deze RPC: de
    -- worker heeft ze niet nodig om een gesprek te voeren, en wat hij niet krijgt kan hij
    -- niet in een prompt laten belanden. Twee booleans zijn genoeg om niet opnieuw te vragen.
    'clientContact', (
      select jsonb_build_object(
        'hasEmail', i.client_email is not null,
        'hasPhone', i.client_phone is not null
      )
      from public.intakes i where i.id = p_intake_id
    ),
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

revoke all on function public.agent_context(text, uuid) from public;
grant execute on function public.agent_context(text, uuid) to anon, authenticated;
