-- De ontdubbeling sluitend maken bij gelijktijdige verzoeken.
--
-- De vorige migratie controleerde of er al een inzage binnen vijf minuten stond, en dat
-- werkt zolang de aanroepen na elkaar komen. Gemeten: tien sequentiële aanroepen leverden
-- nul extra regels op. Maar acht *gelijktijdige* aanroepen op een leeg venster leverden er
-- drie op — ze lezen allemaal voordat de eerste heeft geschreven.
--
-- En dat is precies het gemelde geval: vier regels binnen twee seconden. Een browser die
-- vier verzoeken tegelijk afvuurt, valt in dit gat. De vorige migratie benoemde de race
-- wel, maar noemde hem zeldzaam — dat was optimistisch, en de meting liet het zien.
--
-- ## De oplossing
--
-- Een transactiegebonden advisory lock op (intake, medewerker). Gelijktijdige aanroepen
-- voor hetzelfde paar gaan er één voor één doorheen; de tweede ziet dan de regel van de
-- eerste en schrijft niets. De lock valt vanzelf weg aan het eind van de transactie, dus
-- er is niets op te ruimen en een vastgelopen aanroep blokkeert niemand.
--
-- Waarom geen unieke index: de sleutel is een tijdvenster en geen waarde. Een index op
-- (intake, actor, minuut) zou op elke minuutgrens alsnog een dubbele toelaten.
--
-- De lock is per paar en niet globaal: twee medewerkers die tegelijk verschillende
-- dossiers openen, wachten niet op elkaar.
create or replace function public.log_intake_viewed(p_intake_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_actor uuid;
begin
  select organization_id into v_org
  from public.intakes
  where id = p_intake_id and deleted_at is null;

  if v_org is null or not app.has_org_access(v_org) then
    return;
  end if;

  v_actor := app.current_user_id();

  -- Vanaf hier serieel voor dit ene paar. Vóór de controle, niet erna: anders leest de
  -- tweede aanroeper nog steeds een lege tabel.
  perform pg_advisory_xact_lock(
    pg_catalog.hashtext(p_intake_id::text || ':' || coalesce(v_actor::text, 'anoniem'))
  );

  if exists (
    select 1
    from public.audit_log a
    where a.intake_id = p_intake_id
      and a.action = 'intake.viewed'
      and a.actor_user_id is not distinct from v_actor
      and a.created_at > now() - interval '5 minutes'
  ) then
    return;
  end if;

  perform app.write_audit(
    p_organization_id => v_org,
    p_action          => 'intake.viewed',
    p_entity_type     => 'intake',
    p_entity_id       => p_intake_id,
    p_intake_id       => p_intake_id,
    p_actor_type      => 'user'
  );
end;
$$;
