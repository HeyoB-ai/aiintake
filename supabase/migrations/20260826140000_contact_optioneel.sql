-- Contactgegevens zijn optioneel. Alleen de naam blijft verplicht.
--
-- ## Wat er verandert
--
-- De migratie van vanochtend eiste naam plus minstens één contactkanaal. Die tweede eis
-- vervalt: een e-mailadres en een telefoonnummer mogen allebei leeg blijven.
--
-- ## Waarom
--
-- Het toestemmingsscherm zette "(optioneel)" achter beide velden terwijl de database ze
-- als paar verplicht stelde. Twee manieren om dat gelijk te trekken; de keuze is om het
-- scherm gelijk te geven en de eis te laten vallen.
--
-- ## Wat dat betekent, expliciet
--
-- Er kan hierna een intake binnenkomen met een naam en verder niets. Het dossier is dan
-- compleet genoeg om te lezen en te beoordelen, en er is geen manier om de cliënt terug te
-- bellen. Dat is geen fout meer maar een toegestane toestand, en wie op dit dossier werkt
-- hoort dat te zien in plaats van het te ontdekken bij het opnemen van contact.
--
-- Het dashboard toont een leeg contactveld al als leeg; er is geen extra signalering
-- gebouwd. Blijkt dit in de praktijk vaak voor te komen, dan is een markering op de
-- detailpagina de volgende stap — niet het terugdraaien van deze migratie, want dan is het
-- scherm weer in tegenspraak met de database.
--
-- ## Wat blijft
--
-- De naam blijft verplicht en de e-mailcontrole blijft gelden zodra er iets is ingevuld:
-- een leeg veld is toegestaan, een half adres niet. En lege strings worden nog steeds tot
-- `null` genormaliseerd — anders staat er in de kolom een spatie waar "niets opgegeven"
-- hoort te staan, en dat is in een export niet van elkaar te onderscheiden.
--
-- De signatuur verandert niet, dus `create or replace` behoudt de rechten. De revoke en
-- grant staan er alsnog onder, zodat een latere wijziging aan de parameterlijst niet
-- stilzwijgend een functie zonder rechten oplevert.
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
  p_user_agent_hash        text default null,
  p_client_name            text default null,
  p_client_email           text default null,
  p_client_phone           text default null
)
returns table (intake_id uuid, organization_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_intake_id uuid;
  v_naam text;
  v_email text;
  v_telefoon text;
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

  -- Lege string is geen waarde. Een formulierveld dat is aangeraakt en weer leeggemaakt
  -- levert '' op; dat hoort als "niets opgegeven" in de kolom te staan, niet als spatie.
  v_naam     := nullif(btrim(coalesce(p_client_name, '')), '');
  v_email    := lower(nullif(btrim(coalesce(p_client_email, '')), ''));
  v_telefoon := nullif(btrim(coalesce(p_client_phone, '')), '');

  if v_naam is null or length(v_naam) < 2 then
    raise exception 'een naam is vereist' using errcode = '22023';
  end if;

  -- Geen eis meer op e-mail óf telefoon. Wel: wat er staat moet ergens op lijken.
  if v_email is not null and v_email not like '%_@_%.__%' then
    raise exception 'het e-mailadres lijkt niet te kloppen' using errcode = '22023';
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

  insert into public.intakes (
    organization_id, language, status, practice_area,
    client_name, client_email, client_phone
  )
  values (
    v_org.id, coalesce(p_language, v_org.default_language), 'NEW', 'employment',
    v_naam, v_email, v_telefoon
  )
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

revoke all on function public.create_public_intake(
  text, text, text, text, boolean, text, boolean, text, boolean, boolean, text, text, text, text
) from public;
grant execute on function public.create_public_intake(
  text, text, text, text, boolean, text, boolean, text, boolean, boolean, text, text, text, text
) to anon, authenticated;
