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
comment on schema app is 'Uitsluitend interne helpers. Niet geëxposeerd via PostgREST; het client-gerichte RPC-oppervlak staat in public. Zie docs/ADR-0008.';

revoke all on schema app from public;

-- USAGE is nodig, en is géén exposure.
--
-- Nodig: RLS-policies roepen app.has_org_access() aan, en policy-expressies draaien
-- met de rechten van de bevragende gebruiker. Zonder USAGE faalt elke query met
-- permission denied for schema app.
--
-- Geen exposure: of PostgREST een schema aanbiedt, wordt bepaald door de lijst met
-- geëxposeerde schema's — niet door grants. `app` staat niet in die lijst en is dus
-- niet over HTTP bereikbaar, ongeacht wat hier staat. Dat is precies de scheiding
-- waarop ADR-0008 leunt.
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
-- Lidmaatschap en rollen: zie 0100
-- -----------------------------------------------------------------------------
-- app.is_super_admin(), app.org_ids(), app.has_org_access() en app.has_org_role()
-- stonden hier, maar konden hier niet blijven.
--
-- Een functie met `language sql` krijgt zijn referenties al bij CREATE FUNCTION
-- geresolved, niet pas bij de eerste aanroep. Deze vier lezen public.organization_users,
-- en die tabel bestaat pas in 0100. Op een database waar hij al stond werkte dit; op
-- een verse database faalt het met 42P01. Zulke volgordefouten zijn onzichtbaar zodra
-- je één keer succesvol hebt gemigreerd, en duiken pas weer op in de volgende verse
-- omgeving.
--
-- Ze staan nu in 0100, direct na de tabellen die ze lezen en vóór de policies die ze
-- gebruiken. `pnpm db:check` draait de hele reeks tegen een lege Postgres en bewaakt
-- dat het zo blijft.

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

comment on function app.role_rank(text) is
  'Spiegelt ROLE_RANK in packages/domain/src/enums.ts. Raakt geen tabellen aan en kan daarom hier staan.';
