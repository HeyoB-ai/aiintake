-- =============================================================================
-- 0100  Tenants, gebruikers en rollen
-- =============================================================================
-- RLS staat aan op elke tabel zonder uitzondering (§4). Er is geen tabel in dit
-- project waarvoor "even zonder policy" acceptabel is; een tabel zonder policy is
-- een tabel die niemand kan lezen, en dat is het juiste faalgedrag.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- organizations
-- -----------------------------------------------------------------------------
create table if not exists public.organizations (
  id                uuid primary key default gen_random_uuid(),
  slug              text not null unique
                      check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])$'),
  name              text not null check (length(name) between 1 and 200),
  logo_url          text,
  default_language  text not null default 'nl' check (default_language in ('nl','en')),

  -- Providerkeuze per organisatie; defaults uit env (§5).
  provider_config   jsonb not null default '{}'::jsonb,
  -- Kostenbeheersing (§7).
  session_limits    jsonb not null default '{}'::jsonb,
  -- Acceptatiedrempels; wegen mee in de QuestionPlanner (§6).
  intake_criteria   jsonb not null default '{}'::jsonb,
  -- Bewaartermijnen per kantoor instelbaar (§8.6 architectuurdoc).
  retention_policy  jsonb not null default '{}'::jsonb,

  -- Publiceert de cliëntcamera naar de room? Standaard uit: dan staat er letterlijk
  -- geen clientvideo op enige server. Zie ADR-0004.
  publish_client_video boolean not null default false,

  privacy_policy_version  text not null default 'v1',
  ai_disclosure_version   text not null default 'v1',

  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz
);

create trigger organizations_touch
  before update on public.organizations
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- users  (spiegel van auth.users; auth blijft de bron van waarheid)
-- -----------------------------------------------------------------------------
create table if not exists public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  full_name    text,
  avatar_url   text,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger users_touch
  before update on public.users
  for each row execute function app.touch_updated_at();

-- Nieuwe auth-gebruiker → profielrij. SECURITY DEFINER omdat de trigger draait in
-- de context van het auth-schema.
create or replace function app.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(public.users.full_name, excluded.full_name);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();

-- -----------------------------------------------------------------------------
-- organization_users  (lidmaatschap + rol)
-- -----------------------------------------------------------------------------
create table if not exists public.organization_users (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.users(id) on delete cascade,
  role            text not null check (role in ('SUPER_ADMIN','ORG_ADMIN','LAWYER','INTAKE_STAFF')),
  invited_by      uuid references public.users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  unique (organization_id, user_id)
);

create index if not exists organization_users_user_idx
  on public.organization_users (user_id) where deleted_at is null;
create index if not exists organization_users_org_idx
  on public.organization_users (organization_id) where deleted_at is null;

create trigger organization_users_touch
  before update on public.organization_users
  for each row execute function app.touch_updated_at();

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.organizations      enable row level security;
alter table public.users              enable row level security;
alter table public.organization_users enable row level security;

-- Bewust GEEN `force row level security`.
--
-- FORCE laat RLS ook gelden voor de tabeleigenaar, en dat is precies de rol waaronder
-- SECURITY DEFINER functies draaien. Met FORCE zou elke RPC in 0600 — en daarmee de
-- hele publieke intakeroute en het volledige agent-oppervlak — stuklopen op policies
-- die er voor die rol niet zijn. De tenantgrens wordt gedragen door ENABLE + policies
-- voor `authenticated` en `anon`; dat zijn de enige rollen die een client ooit heeft.
-- Zie docs/ADR-0003-rls-en-agent-token.md.

-- organizations ---------------------------------------------------------------
create policy organizations_select_own on public.organizations
  for select to authenticated
  using (app.has_org_access(id));

create policy organizations_update_admin on public.organizations
  for update to authenticated
  using (app.has_org_role(id, 'ORG_ADMIN'))
  with check (app.has_org_role(id, 'ORG_ADMIN'));

create policy organizations_insert_super on public.organizations
  for insert to authenticated
  with check (app.is_super_admin());

create policy organizations_delete_super on public.organizations
  for delete to authenticated
  using (app.is_super_admin());

-- users -----------------------------------------------------------------------
create policy users_select_self on public.users
  for select to authenticated
  using (id = app.current_user_id());

-- Collega's binnen dezelfde organisatie zijn zichtbaar (voor "toegewezen aan").
create policy users_select_colleagues on public.users
  for select to authenticated
  using (
    exists (
      select 1
      from public.organization_users ou
      where ou.user_id = public.users.id
        and ou.deleted_at is null
        and ou.organization_id in (select app.org_ids())
    )
  );

create policy users_update_self on public.users
  for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

-- organization_users ----------------------------------------------------------
-- Let op: deze policies mogen `organization_users` niet direct bevragen. Ze gaan
-- via app.* helpers, die SECURITY DEFINER zijn en dus geen policy-recursie geven.
create policy organization_users_select_same_org on public.organization_users
  for select to authenticated
  using (app.has_org_access(organization_id));

create policy organization_users_insert_admin on public.organization_users
  for insert to authenticated
  with check (app.has_org_role(organization_id, 'ORG_ADMIN'));

create policy organization_users_update_admin on public.organization_users
  for update to authenticated
  using (app.has_org_role(organization_id, 'ORG_ADMIN'))
  with check (app.has_org_role(organization_id, 'ORG_ADMIN'));

create policy organization_users_delete_admin on public.organization_users
  for delete to authenticated
  using (app.has_org_role(organization_id, 'ORG_ADMIN'));

-- -----------------------------------------------------------------------------
-- Publieke lookup van een kantoor op slug, voor /intake/[organizationSlug].
-- -----------------------------------------------------------------------------
-- De publieke intakepagina heeft naam, logo en taal nodig — en niets anders.
-- Daarom een functie met een expliciet uitgeschreven kolomlijst in plaats van
-- een select-policy voor `anon` op de hele tabel: dan lekken provider_config,
-- intake_criteria en retention_policy naar het publiek.
create or replace function app.public_org_by_slug(p_slug text)
returns table (
  id uuid,
  slug text,
  name text,
  logo_url text,
  default_language text,
  privacy_policy_version text,
  ai_disclosure_version text
)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.slug, o.name, o.logo_url, o.default_language,
         o.privacy_policy_version, o.ai_disclosure_version
  from public.organizations o
  where o.slug = p_slug
    and o.is_active
    and o.deleted_at is null;
$$;

revoke all on function app.public_org_by_slug(text) from public;
grant execute on function app.public_org_by_slug(text) to anon, authenticated;
