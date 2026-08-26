-- De worker moet weten wie er tegenover hem zit.
--
-- ## Wat er ontbrak
--
-- `agent_context` gaf de intake terug zonder `client_name`, en de organisatie zonder
-- `time_zone`. De worker kon dus niet groeten bij naam — hij wist niet dat er een naam wás
-- — en niet weten in welke tijdzone het kantoor staat, terwijl de openingsgroet en het
-- datumanker daar allebei aan hangen.
--
-- Dat viel niet op omdat de worker `agent_context` helemaal niet aanriep en op een
-- hardgecodeerde organisatie draaide. Nu hij hem gaat aanroepen, moeten die twee velden
-- erin.
--
-- ## Waarom de naam hier hoort en niet als feit
--
-- De naam wordt sinds 26 augustus op het toestemmingsscherm getypt en staat als kolom op
-- `intakes`. Hij is geen `case_fact`: er is geen citaat dat hem staaft en er valt niet op
-- door te vragen. Hem uit de feitenlijst laten komen zou betekenen dat de assistent pas
-- weet hoe je heet nadat de extractie een ronde heeft gedraaid — en dat is ná de opening.
--
-- ## Wat er niet bij komt
--
-- Geen e-mailadres en geen telefoonnummer. De worker heeft ze niet nodig om een gesprek te
-- voeren, en wat hij niet krijgt kan hij niet in een prompt laten belanden. Het contract
-- van deze functie is het contract van wat het model mag zien.
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

-- De signatuur verandert niet, dus `create or replace` behoudt de rechten. Toch expliciet,
-- zodat een latere wijziging aan de parameterlijst niet stilzwijgend een functie zonder
-- rechten oplevert.
revoke all on function public.agent_context(text, uuid) from public;
grant execute on function public.agent_context(text, uuid) to anon, authenticated;
