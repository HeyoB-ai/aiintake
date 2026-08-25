-- Een agent-token controleren zonder er iets mee te doen.
--
-- De worker kon een token alleen valideren door een `agent_*`-RPC aan te roepen die
-- daarnaast iets schrijft — een metriek, een beurt, een voortgangsveld. Voor het moment
-- waarop een cliënt de WebSocket opent is dat verkeerd om: dan is er nog geen beurt en
-- geen metriek, en een sessie die wordt geweigerd zou toch een spoor achterlaten.
--
-- Waarom dit nodig werd: `apps/agent/live/server.ts` accepteerde elke verbinding. Als
-- ontwikkelharnas was dat te verdedigen; zodra de echte cliëntpagina erop aansluit, is het
-- een open deur naar een dienst die per seconde geld kost.
--
-- Geeft dezelfde vier weigeringen als app.assert_agent_scope: onbekend, verlopen,
-- ingetrokken, of gebonden aan een andere intake.
create or replace function public.agent_verify_session(
  p_session_token text,
  p_intake_id     uuid
)
returns table (organization_id uuid, session_id uuid, language text, org_name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scope record;
begin
  select * into v_scope from app.assert_agent_scope(p_session_token, p_intake_id);

  organization_id := v_scope.organization_id;
  session_id := v_scope.session_id;

  -- De taal en de kantoornaam komen mee omdat de worker ze allebei nodig heeft voor de
  -- openingsbeurt, en een tweede ronde naar de database daarvoor onnodig is.
  select i.language into language from public.intakes i where i.id = p_intake_id;
  select o.name into org_name
  from public.organizations o
  join public.intakes i on i.organization_id = o.id
  where i.id = p_intake_id;

  return next;
end;
$$;

revoke all on function public.agent_verify_session(text, uuid) from public, anon, authenticated;
grant execute on function public.agent_verify_session(text, uuid) to anon, authenticated;

comment on function public.agent_verify_session(text, uuid) is
  'Controleert een agent-sessietoken zonder neveneffect. Voor het openen van de realtime-verbinding.';
