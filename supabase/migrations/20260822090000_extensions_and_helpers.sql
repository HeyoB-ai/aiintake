-- =============================================================================
-- 0000  Extensies, app-schema en autorisatiehelpers
-- =============================================================================
-- Alle RLS-policies in dit project leunen op de functies hieronder. Ze zijn
-- SECURITY DEFINER met een vastgezet search_path, om twee redenen:
--
--   1. Recursie. Een policy op `organization_users` die zelf `organization_users`
--      bevraagt, veroorzaakt "infinite recursion detected in policy". Binnen een
--      SECURITY DEFINER functie wordt RLS niet opnieuw toegepast, dus de lus breekt.
--   2. Snelheid. STABLE + gemarkeerd als PARALLEL SAFE, zodat de planner ze per
--      query één keer evalueert in plaats van per rij.
--
-- search_path staat expliciet leeg (pg_catalog only) zodat een aanvaller met
-- CREATE-rechten op een ander schema geen functie kan kapen.
-- =============================================================================

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "pg_trgm" with schema extensions;

create schema if not exists app;
comment on schema app is 'Interne helpers en RPC-oppervlak. Niet direct exposed via PostgREST behalve de expliciet gegrante functies.';

revoke all on schema app from public;
grant usage on schema app to authenticated, anon, service_role;

-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Identiteit
-- -----------------------------------------------------------------------------

-- Het volledige JWT als jsonb. Leeg object buiten een request-context (bijv. in psql).
create or replace function app.jwt()
returns jsonb
language sql
stable
parallel safe
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

-- De ingelogde gebruiker, of null bij anon / agent-token.
-- Leest uit request.jwt.claims in plaats van auth.uid(), zodat de helpers ook werken
-- in tests die het JWT met set_config zetten zonder het auth-schema te laden.
create or replace function app.current_user_id()
returns uuid
language sql
stable
parallel safe
set search_path = ''
as $$
  select nullif(app.jwt() ->> 'sub', '')::uuid;
$$;

-- -----------------------------------------------------------------------------
-- Het sessietoken van de agent-worker: zie 0300 (tabel) en 0600 (verificatie)
-- -----------------------------------------------------------------------------
-- Hier stond eerder een paar helpers die het agent-token uit `request.jwt.claims`
-- lazen. Dat werkt niet meer, en het is nuttig te weten waarom:
--
-- Die opzet legde het token in de Authorization-header en liet PostgREST het
-- verifiëren. Bij asymmetrische JWT signing keys verifieert PostgREST tegen de JWKS
-- van het project, en die private key zit in Supabase Auth — wij kunnen dus geen
-- token maken dat PostgREST accepteert. Elk zelfgemaakt token levert 401 op vóórdat
-- er een RPC draait.
--
-- Het token reist daarom niet meer als bearer credential maar als expliciete
-- RPC-parameter, en wordt geverifieerd met een lookup in `public.session_tokens`.
-- Zie docs/ADR-0007-agent-sessietoken.md.

-- -----------------------------------------------------------------------------
-- Lidmaatschap en rollen
-- -----------------------------------------------------------------------------

create or replace function app.is_super_admin()
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_users ou
    where ou.user_id = app.current_user_id()
      and ou.role = 'SUPER_ADMIN'
      and ou.deleted_at is null
  );
$$;

-- Alle organisaties waar de huidige gebruiker lid van is.
create or replace function app.org_ids()
returns setof uuid
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select ou.organization_id
  from public.organization_users ou
  where ou.user_id = app.current_user_id()
    and ou.deleted_at is null;
$$;

create or replace function app.has_org_access(target_org uuid)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select target_org is not null and (
    app.is_super_admin()
    or exists (
      select 1
      from public.organization_users ou
      where ou.user_id = app.current_user_id()
        and ou.organization_id = target_org
        and ou.deleted_at is null
    )
  );
$$;

-- Rangorde spiegelt ROLE_RANK in packages/domain/src/enums.ts.
create or replace function app.role_rank(r text)
returns int
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case r
    when 'INTAKE_STAFF' then 1
    when 'LAWYER'       then 2
    when 'ORG_ADMIN'    then 3
    when 'SUPER_ADMIN'  then 4
    else 0
  end;
$$;

create or replace function app.has_org_role(target_org uuid, min_role text)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select app.is_super_admin()
    or exists (
      select 1
      from public.organization_users ou
      where ou.user_id = app.current_user_id()
        and ou.organization_id = target_org
        and ou.deleted_at is null
        and app.role_rank(ou.role) >= app.role_rank(min_role)
    );
$$;

-- Voor policies op kindtabellen: hoort deze intake bij een org waar ik bij mag?
create or replace function app.can_read_intake(target_intake uuid)
returns boolean
language sql
stable
parallel safe
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.intakes i
    where i.id = target_intake
      and app.has_org_access(i.organization_id)
  );
$$;

comment on function app.org_ids() is
  'SECURITY DEFINER om policy-recursie op organization_users te voorkomen.';
