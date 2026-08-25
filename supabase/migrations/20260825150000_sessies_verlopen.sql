-- Een sessie die niemand meer voert, telt niet meer mee.
--
-- ## Wat er misging
--
-- `issue_agent_session` telde de gelijktijdige sessies als `ended_at is null`, zonder
-- enige tijdsgrens. Een rij die nooit werd afgesloten bleef daardoor voor altijd een
-- "actieve sessie". Vijf zulke rijen — drie uit mislukte pogingen, één uit een gesprek dat
-- normaal was gestopt — en `maxConcurrentSessions` (standaard 5) zit vol. De volgende
-- bezoeker krijgt "maximum aantal gelijktijdige sessies bereikt", en niets aan de
-- foutmelding wijst naar de oorzaak.
--
-- Dat is een ontwerpfout en geen ongeluk: elke crash, elke deploy midden in een gesprek en
-- elk foutpad dat vóór het afsluiten stopt, legt de dienst een stukje verder plat. Zonder
-- vervaltermijn is de enige uitweg met de hand opruimen in de database.
--
-- ## Waarom hier en niet alleen in de worker
--
-- De worker schrijft `ended_at` nu wél bij het sluiten van de socket (zie
-- apps/agent/live/server.ts). Maar juist de gevallen die dit probleem veroorzaken zijn de
-- gevallen waarin de worker niets meer kán schrijven: het proces is weg, het netwerk is
-- weg, of de rij is nooit door een worker opgepakt. Een opruiming die afhangt van het
-- onderdeel dat crashte, ruimt niet op.
--
-- ## De grens
--
-- `maxSessionMinutes + 5`, dezelfde marge waarmee hierboven de token-TTL wordt berekend.
-- Dat is geen tweede keuze maar dezelfde: langer dan dat kan het token niet geldig zijn,
-- dus langer dan dat kan er geen gesprek meer lopen. Twee getallen die hetzelfde moeten
-- betekenen horen uit dezelfde bron te komen.
--
-- `ended_at` wordt op het laatste moment gezet waarop de sessie nog kán hebben gelopen, en
-- niet op `now()`. Anders krijgt een rij die drie dagen bleef staan een duur van drie
-- dagen, en dat is een verzonnen getal in een tabel waarop kosten worden geanalyseerd.
-- `billed_seconds` blijft `null`: wat er werkelijk verbruikt is, weten we hier niet, en een
-- geschat getal is in die kolom niet van een gemeten getal te onderscheiden.
--
-- ## Wat dit niet doet
--
-- Dit ruimt op bij het uitgeven van een nieuwe sessie, want dat is het moment waarop de
-- telling ertoe doet. Komt er niemand meer langs, dan blijven verlopen rijen op `null`
-- staan tot de volgende poging. Voor de limiet maakt dat niets uit — die wordt nergens
-- anders gelezen — maar een dashboard dat "actieve sessies" op deze kolom baseert, ziet ze
-- wel. Vermeld omdat een lezer anders mag aannemen dat de kolom altijd klopt.
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
  v_levensduur interval;
  v_verlopen int;
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

  -- Dezelfde marge als de token-TTL hieronder. Eén bron voor één getal.
  v_levensduur := (v_max_minutes + 5) * interval '1 minute';

  -- Eerst opruimen, dan tellen. Andersom telt deze aanroep de rijen mee die hij zelf
  -- zojuist als verlopen zou hebben herkend.
  update public.sessions s
     set ended_at = s.started_at + v_levensduur,
         end_reason = 'timeout'
   where s.organization_id = v_org
     and s.ended_at is null
     and s.started_at < now() - v_levensduur;

  get diagnostics v_verlopen = row_count;

  if v_verlopen > 0 then
    -- In het auditlog, want dit is een systeemhandeling die de toestand van sessies
    -- verandert. Eén regel per opruiming en niet per rij: het is één beslissing.
    --
    -- Zonder `intake_id`, en dat is geen slordigheid: de opgeruimde sessies horen bij
    -- ándere intakes dan degene die nu wordt aangemaakt. Die van p_intake_id erbij zetten
    -- zou een verband suggereren dat er niet is.
    insert into public.audit_log (organization_id, action, actor_type, entity_type, metadata)
    values (v_org, 'session.ended', 'system', 'session',
            jsonb_build_object('reden', 'verlopen', 'aantal', v_verlopen));
  end if;

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

-- Ongewijzigd ten opzichte van de oorspronkelijke migratie, maar `create or replace`
-- herstelt de rechten niet: die horen bij de functie en moeten opnieuw gezet worden.
revoke all on function public.issue_agent_session(uuid, text, text, int, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.issue_agent_session(uuid, text, text, int, text, timestamptz)
  to service_role;
