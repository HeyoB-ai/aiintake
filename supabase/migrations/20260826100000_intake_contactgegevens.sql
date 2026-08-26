-- Naam en contactgegevens horen bij het aanmaken van de intake, niet erna.
--
-- ## Waarom niet via het gesprek
--
-- De assistent vroeg er niet naar, en dat hoort ook zo te blijven. Een naam is geen feit
-- om via spraak op te halen: er valt niet op door te vragen, er is geen citaat dat hem
-- staaft, en spraakherkenning is op eigennamen juist het zwakst — "Van Dijk" wordt
-- "Vandijk", "Sjoerd" wordt "Sjoert". Een verkeerd verstane achternaam in een dossier is
-- erger dan een lege kolom: hij ziet er ingevuld uit.
--
-- Getypt op het toestemmingsscherm is het precies één keer goed, en de cliënt ziet wat hij
-- afgeeft voordat hij akkoord gaat.
--
-- ## Waarom in deze functie en niet in een update erna
--
-- `public.intakes` heeft met opzet geen insert-policy: nieuwe intakes ontstaan uitsluitend
-- hier, met de rate limiting en de toestemming in dezelfde transactie. Diezelfde redenering
-- geldt voor deze velden. Ze zijn de persoonsgegevens waarvoor op dat scherm toestemming
-- wordt gegeven; ze in een tweede aanroep toevoegen zou betekenen dat er een toestand
-- bestaat waarin de toestemming is vastgelegd en de gegevens nog niet, of andersom.
--
-- ## Waarom de eis hier staat en niet alleen in het formulier
--
-- Een formulier is een gemak voor wie het invult, geen grens. De regel "naam plus minstens
-- één contactkanaal" staat daarom in de database, net als de consenteis erboven: een tweede
-- client schrijven mag niet genoeg zijn om eromheen te komen.
--
-- ## De e-mailcontrole is bewust ruw
--
-- `%_@_%.__%` en verder niets. Strengere patronen wijzen echte adressen af — apostrofen,
-- plustekens, nieuwe TLD's, IDN — en dat is hier de duurste fout: een cliënt die zijn eigen
-- adres niet kwijt kan, haakt af en belt niet alsnog. Wat we willen vangen is de typefout
-- en het lege veld, niet het randgeval.
--
-- ## Drop en create, geen create or replace
--
-- Er komen drie parameters bij. Met `default null` levert dat een tweede signatuur op in
-- plaats van een vervanging, en dan bestaan er twee `create_public_intake`-functies
-- naast elkaar — PostgREST kiest er dan zelf een, afhankelijk van welke velden er in de
-- body zitten. Precies het soort dubbelzinnigheid dat een maand later een raadsel is.
drop function if exists public.create_public_intake(
  text, text, text, text, boolean, text, boolean, text, boolean, boolean, text
);

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
  -- levert '' op, en dat zou als "ingevuld" tellen in de controles hieronder.
  v_naam     := nullif(btrim(coalesce(p_client_name, '')), '');
  v_email    := lower(nullif(btrim(coalesce(p_client_email, '')), ''));
  v_telefoon := nullif(btrim(coalesce(p_client_phone, '')), '');

  if v_naam is null or length(v_naam) < 2 then
    raise exception 'een naam is vereist' using errcode = '22023';
  end if;

  if v_email is null and v_telefoon is null then
    raise exception 'een e-mailadres of telefoonnummer is vereist' using errcode = '22023';
  end if;

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

-- De rechten horen bij de signatuur, en die is veranderd. Zonder deze twee regels staat de
-- functie na de migratie open voor `public`.
revoke all on function public.create_public_intake(
  text, text, text, text, boolean, text, boolean, text, boolean, boolean, text, text, text, text
) from public;
grant execute on function public.create_public_intake(
  text, text, text, text, boolean, text, boolean, text, boolean, boolean, text, text, text, text
) to anon, authenticated;
