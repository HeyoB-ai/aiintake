-- =============================================================================
-- Bootstrap voor de migratietest
-- =============================================================================
-- Onze migraties draaien op Supabase en gaan uit van objecten die het platform zelf
-- meelevert: de rollen anon/authenticated/service_role, het extensions-schema, en de
-- auth- en storage-schema's. Een kale Postgres heeft die niet.
--
-- Dit bestand maakt precies dat vooraf aan — niet meer. Alles wat onze eigen
-- migraties horen te maken, staat hier bewust NIET in: anders zou de test een
-- ontbrekende definitie kunnen maskeren.
--
-- Dit bestand is uitsluitend voor de test. Het wordt nooit tegen een Supabase-project
-- gedraaid; daar bestaan deze objecten al.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Rollen
-- -----------------------------------------------------------------------------
-- PostgREST wisselt naar deze rollen op basis van de JWT-claim `role`.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Schema's
-- -----------------------------------------------------------------------------
create schema if not exists extensions;
create schema if not exists auth;
create schema if not exists storage;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- auth.users
-- -----------------------------------------------------------------------------
-- Alleen de kolommen die onze migraties aanraken: de foreign key vanuit
-- public.users, en de velden die app.handle_new_auth_user() leest.
create table if not exists auth.users (
  id                   uuid primary key default gen_random_uuid(),
  email                text,
  raw_user_meta_data   jsonb default '{}'::jsonb,
  created_at           timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- storage
-- -----------------------------------------------------------------------------
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets(id),
  name       text,
  owner      uuid,
  created_at timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- Splitst een objectpad in mapcomponenten. Onze storage-policies gebruiken de eerste
-- component als tenantgrens, dus het gedrag moet overeenkomen met dat van Supabase:
-- de bestandsnaam zelf valt eraf.
create or replace function storage.foldername(name text)
returns text[]
language plpgsql
immutable
as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1:array_length(parts, 1) - 1];
end
$$;

grant usage on schema storage to anon, authenticated, service_role;
