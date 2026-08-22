-- =============================================================================
-- 0400  Documenten, analyse en opslag
-- =============================================================================

create table if not exists public.documents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  intake_id        uuid not null references public.intakes(id) on delete cascade,

  filename         text not null check (length(filename) between 1 and 300),
  mime_type        text not null check (mime_type in (
                     'application/pdf',
                     'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                     'image/jpeg',
                     'image/png')),
  -- Pad in de bucket: {organization_id}/{intake_id}/{document_id}{ext}.
  -- De eerste map is de tenantgrens waar de storage-policies op sturen.
  storage_path     text not null unique,
  size_bytes       int not null check (size_bytes > 0 and size_bytes <= 20971520),
  -- Wat de serverkant in de magic bytes aantrof. Wijkt dit af van mime_type, dan is
  -- het bestand geweigerd: de extensie is nooit het bewijs (§9).
  detected_type    text,
  checksum_sha256  text,

  uploaded_by_role text not null check (uploaded_by_role in ('client','lawyer','intake_staff')),
  uploaded_by      uuid references public.users(id) on delete set null,

  analysis_status  text not null default 'pending'
                     check (analysis_status in ('pending','processing','completed','failed','rejected')),
  rejection_reason text,

  uploaded_at      timestamptz not null default now(),
  purge_after      timestamptz,
  deleted_at       timestamptz
);

create index if not exists documents_intake_idx on public.documents (intake_id, uploaded_at desc);
create index if not exists documents_purge_idx on public.documents (purge_after) where purge_after is not null;

-- -----------------------------------------------------------------------------
-- document_analysis
-- -----------------------------------------------------------------------------
-- De output is een BEWERING met confidence, geen feit (§9). Documentinhoud komt
-- nooit op het hot path; deze tabel is puur cold path.
create table if not exists public.document_analysis (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  document_id        uuid not null references public.documents(id) on delete cascade,
  intake_id          uuid not null references public.intakes(id) on delete cascade,

  document_type      text,
  document_date      date,
  parties            text[] not null default '{}',
  important_dates    jsonb not null default '[]'::jsonb,
  short_summary      text,
  potential_deadlines jsonb not null default '[]'::jsonb,
  notable_clauses    text[] not null default '{}',
  confidence         numeric(4,3) check (confidence between 0 and 1),

  -- Trof het model instructie-achtige tekst aan ("negeer voorgaande instructies")?
  -- Dan blokkeert dit automatische urgentieverhoging en vraagt het om menselijke blik.
  contains_instruction_like_text boolean not null default false,

  llm_call_id        uuid references public.llm_calls(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (document_id)
);

create index if not exists document_analysis_intake_idx on public.document_analysis (intake_id);

-- =============================================================================
-- Storage
-- =============================================================================
-- Private bucket. Toegang uitsluitend via signed URLs met korte TTL (§9); er is
-- bewust geen publieke leesweg.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'intake-documents',
  'intake-documents',
  false,
  20971520,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- De eerste padcomponent is de organization_id. Zit die niet in jouw organisaties,
-- dan bestaat het object voor jou niet — ook niet als je het pad raadt.
create policy intake_documents_select_own_org on storage.objects
  for select to authenticated
  using (
    bucket_id = 'intake-documents'
    and app.has_org_access(nullif((storage.foldername(name))[1], '')::uuid)
  );

create policy intake_documents_insert_own_org on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'intake-documents'
    and app.has_org_role(nullif((storage.foldername(name))[1], '')::uuid, 'INTAKE_STAFF')
  );

create policy intake_documents_delete_admin on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'intake-documents'
    and app.has_org_role(nullif((storage.foldername(name))[1], '')::uuid, 'ORG_ADMIN')
  );

-- De cliënt uploadt niet rechtstreeks naar storage: de server valideert eerst magic
-- bytes en schrijft daarna met een service-role client. Daarom géén anon-policy.

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.documents         enable row level security;
alter table public.document_analysis enable row level security;
-- Geen FORCE: zie de toelichting in 0100.

create policy documents_select_org on public.documents
  for select to authenticated
  using (app.has_org_access(organization_id) and deleted_at is null);

create policy documents_insert_staff on public.documents
  for insert to authenticated
  with check (app.has_org_role(organization_id, 'INTAKE_STAFF'));

create policy documents_update_staff on public.documents
  for update to authenticated
  using (app.has_org_role(organization_id, 'INTAKE_STAFF'))
  with check (app.has_org_role(organization_id, 'INTAKE_STAFF'));

create policy document_analysis_select_org on public.document_analysis
  for select to authenticated
  using (app.has_org_access(organization_id));
