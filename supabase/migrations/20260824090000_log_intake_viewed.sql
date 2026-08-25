-- Een advocaat die een dossier opent, hoort in het log te staan.
--
-- `audit_log` heeft met opzet geen insert-policy: schrijven gaat uitsluitend via
-- app.write_audit(), zodat niemand een gebeurtenis met een gekozen actor of tijdstip kan
-- neerzetten. Daardoor kan de dashboardpagina zelf niets loggen — en `intake.viewed` staat
-- wél in de lijst toegestane acties. Deze functie is het ontbrekende stuk.
--
-- Waarom dit ertoe doet: een intakedossier bevat gezondheidsgegevens en de omstandigheden
-- van iemands ontslag. Wie het heeft ingezien is dan geen boekhouding maar een
-- verantwoordingsvraag.
--
-- Alleen `intake.viewed`, geen vrije actie als parameter. Een RPC waarmee de client zelf
-- kiest wát er in het log komt, is precies de vervalsing die de ontbrekende insert-policy
-- moest voorkomen.
create or replace function public.log_intake_viewed(p_intake_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  select organization_id into v_org
  from public.intakes
  where id = p_intake_id and deleted_at is null;

  -- Geen toegang of niet gevonden: stil niets doen. De pagina zelf loopt al tegen RLS aan
  -- en toont dan een nette melding; hier alsnog een fout gooien zou die melding vervangen
  -- door een stacktrace, en het log is geen toegangscontrole.
  if v_org is null or not app.has_org_access(v_org) then
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

revoke all on function public.log_intake_viewed(uuid) from public, anon;
grant execute on function public.log_intake_viewed(uuid) to authenticated;

comment on function public.log_intake_viewed(uuid) is
  'Legt vast dat een medewerker dit intakedossier heeft ingezien. Enige toegestane weg voor de applicatie om audit_log te vullen.';
