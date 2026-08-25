-- Eén inzage is één regel, ook als de pagina meerdere keren rendert.
--
-- Waargenomen op een iPhone: vier regels `intake.viewed` binnen twee seconden bij één
-- bezoek. Op Chromium is het er precies één per navigatie — gemeten met drie
-- navigatievormen — dus de vermenigvuldiging komt van de browser en niet van de
-- applicatie. Welke Safari-eigenaardigheid het precies is (speculatief laden, een
-- herhaalde tap, terugkeer uit de bfcache) is hier niet vast te stellen.
--
-- Dat is juist de reden om het hier op te lossen en niet in de pagina: welke browser er
-- ook hoe vaak rendert, het log hoort de gebeurtenis één keer te bevatten. Een auditlog
-- waarin één inzage vier regels oplevert, is als bewijs onbruikbaar — en erger, de échte
-- gebeurtenissen verdrinken erin.
--
-- ## Het venster
--
-- Vijf minuten. Korter en een trage pagina levert alsnog dubbele regels; langer en twee
-- echt losse raadplegingen worden er één. Vijf minuten is de grens waarbinnen
-- "hij heeft dit dossier bekeken" redelijkerwijs één handeling is.
--
-- ## Wat dit niet oplost
--
-- Twee gelijktijdige renders kunnen allebei langs de controle glippen voordat de eerste
-- heeft geschreven. Dat levert dan twee regels op in plaats van vier, en het is met een
-- `unique`-index niet af te vangen omdat de sleutel een tijdvenster is en geen waarde.
-- Vermeld omdat een lezer anders mag denken dat dit gegarandeerd is.
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

  -- Geen toegang of niet gevonden: stil niets doen. De pagina loopt zelf al tegen RLS aan
  -- en toont een nette melding; hier alsnog gooien zou die vervangen door een stacktrace,
  -- en het log is geen toegangscontrole.
  if v_org is null or not app.has_org_access(v_org) then
    return;
  end if;

  v_actor := app.current_user_id();

  -- Dezelfde medewerker, hetzelfde dossier, binnen het venster: al vastgelegd.
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

-- De bestaande index op (intake_id) dekt de zoekopdracht hierboven niet efficiënt zodra
-- een dossier veel gebeurtenissen heeft; deze wel, en alleen voor de inzages.
create index if not exists audit_log_viewed_recent_idx
  on public.audit_log (intake_id, actor_user_id, created_at desc)
  where action = 'intake.viewed';
