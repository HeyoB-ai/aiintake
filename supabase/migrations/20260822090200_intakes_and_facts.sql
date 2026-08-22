-- =============================================================================
-- 0200  Intakes, transcript, feiten, risicovlaggen, advocaatverzoeken
-- =============================================================================

create table if not exists public.intakes (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,

  practice_area   text not null default 'employment' check (practice_area in ('employment')),
  language        text not null default 'nl' check (language in ('nl','en')),
  status          text not null default 'NEW' check (status in (
                    'NEW','IN_PROGRESS','READY_FOR_REVIEW','MORE_INFO_REQUESTED',
                    'ACCEPTED','REJECTED','REFERRED','NEEDS_HUMAN_CHECK')),

  -- Contactgegevens worden ook als case_fact vastgelegd; deze kolommen zijn de
  -- gedenormaliseerde kopie waarop het dashboard sorteert en zoekt.
  client_name     text,
  client_email    text,
  client_phone    text,
  subject         text,

  urgency_level   text check (urgency_level in ('LOW','MEDIUM','HIGH','CRITICAL')),
  completeness    numeric(4,3) check (completeness between 0 and 1),

  assigned_to     uuid references public.users(id) on delete set null,
  template_key    text,
  template_version int,

  -- Conflictcheck vóór afronding: staat het kantoor de wederpartij al bij?
  conflict_check_status text not null default 'pending'
                    check (conflict_check_status in ('pending','clear','conflict','waived')),
  conflict_check_note   text,

  summary_id      uuid,
  turn_count      int not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  completed_at    timestamptz,
  reviewed_at     timestamptz,
  reviewed_by     uuid references public.users(id) on delete set null,
  -- Retentie: gezet door de cleanup-service op basis van organizations.retention_policy.
  purge_after     timestamptz,
  deleted_at      timestamptz
);

create index if not exists intakes_org_status_idx
  on public.intakes (organization_id, status, created_at desc) where deleted_at is null;
create index if not exists intakes_org_urgency_idx
  on public.intakes (organization_id, urgency_level, created_at desc) where deleted_at is null;
create index if not exists intakes_assigned_idx
  on public.intakes (assigned_to) where deleted_at is null;
create index if not exists intakes_purge_idx
  on public.intakes (purge_after) where purge_after is not null;

create trigger intakes_touch
  before update on public.intakes
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- messages  — het transcript
-- -----------------------------------------------------------------------------
-- Hier staat ALLEEN wat de cliënt daadwerkelijk heeft gehoord of gelezen (§7 stap d).
-- `intended_content` bewaart wat het model wilde zeggen, uitsluitend voor audit; die
-- kolom gaat nooit als history naar het LLM. Zonder dit onderscheid gelooft het model
-- dat het vragen heeft gesteld die nooit hoorbaar waren.
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intake_id       uuid not null references public.intakes(id) on delete cascade,
  session_id      uuid,
  turn_index      int not null,
  role            text not null check (role in ('assistant','client','system')),

  content         text not null,
  intended_content text,
  interrupted_at_char int check (interrupted_at_char >= 0),
  spoken_ms       int check (spoken_ms >= 0),

  planned_question_keys text[] not null default '{}',
  llm_call_id     uuid,
  created_at      timestamptz not null default now()
);

create index if not exists messages_intake_idx
  on public.messages (intake_id, turn_index);
create index if not exists messages_session_idx
  on public.messages (session_id, turn_index);

comment on column public.messages.content is
  'Uitsluitend het gehoorde/gelezen deel. Bij barge-in afgekapt op de uitgesproken prefix.';
comment on column public.messages.intended_content is
  'Volledige voorgenomen tekst. Alleen voor audit — nooit als conversatiegeschiedenis gebruiken.';

-- -----------------------------------------------------------------------------
-- case_facts
-- -----------------------------------------------------------------------------
-- De sleutelcatalogus staat in packages/domain/src/facts/employment.ts, niet hier:
-- een nieuwe intakevraag kost een deploy, geen migratie.
create table if not exists public.case_facts (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intake_id       uuid not null references public.intakes(id) on delete cascade,

  key             text not null check (length(key) between 1 and 120),
  value           jsonb,
  value_type      text not null check (value_type in ('string','number','date','boolean','enum')),
  -- 'unknown' is een expliciete waarde. "Niet vastgesteld" is een feit, geen leegte.
  status          text not null check (status in ('confirmed','inferred','unknown','contradicted')),
  confidence      numeric(4,3) not null default 0 check (confidence between 0 and 1),
  source          text not null check (source in ('client_statement','document','lawyer_input')),
  source_ref      text,
  evidence_quote  text,
  llm_call_id     uuid,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (intake_id, key),

  -- Een vastgesteld feit zonder herkomst mag niet bestaan. Dit is de databasekant van
  -- de regel dat elke bewering in de samenvatting herleidbaar is (§10).
  constraint case_facts_traceable check (status = 'unknown' or source_ref is not null)
);

create index if not exists case_facts_intake_idx on public.case_facts (intake_id);
create index if not exists case_facts_key_idx on public.case_facts (organization_id, key);

create trigger case_facts_touch
  before update on public.case_facts
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- risk_flags  — urgentie
-- -----------------------------------------------------------------------------
-- Rule-based is de bron van waarheid; AI mag alleen signaleren. `detected_by` legt
-- vast welke van de twee de vlag heeft gezet.
create table if not exists public.risk_flags (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intake_id       uuid not null references public.intakes(id) on delete cascade,

  rule_key        text not null,
  level           text not null check (level in ('LOW','MEDIUM','HIGH','CRITICAL')),
  label           text not null,
  detected_by     text not null check (detected_by in ('rule','rule+ai')),
  source_ref      text,
  -- Een deadline uit een document verhoogt de urgentie pas na een tweede,
  -- onafhankelijke regelcheck (§9). Tot dan staat dit op false.
  independently_confirmed boolean not null default false,

  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid references public.users(id) on delete set null,

  unique (intake_id, rule_key)
);

create index if not exists risk_flags_intake_idx on public.risk_flags (intake_id, level);

-- -----------------------------------------------------------------------------
-- lawyer_requests  — "meer informatie"
-- -----------------------------------------------------------------------------
-- Vrije tekst van de advocaat. Bij de volgende sessie zet de engine dit om in
-- natuurlijke vragen met voorrang.
create table if not exists public.lawyer_requests (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intake_id       uuid not null references public.intakes(id) on delete cascade,
  requested_by    uuid not null references public.users(id) on delete cascade,
  body            text not null check (length(body) between 1 and 4000),
  status          text not null default 'open' check (status in ('open','asked','answered','cancelled')),
  asked_in_session uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists lawyer_requests_intake_idx
  on public.lawyer_requests (intake_id, status);

create trigger lawyer_requests_touch
  before update on public.lawyer_requests
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- summaries
-- -----------------------------------------------------------------------------
create table if not exists public.summaries (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intake_id       uuid not null references public.intakes(id) on delete cascade,
  sections        jsonb not null,
  not_established text[] not null default '{}',
  llm_call_id     uuid,
  -- Bevat de samenvatting een bewering die niet naar een fact of transcriptregel te
  -- herleiden is? Dan markeren voor menselijke controle in plaats van tonen als klaar.
  grounding_ok    boolean not null default false,
  ungrounded_claims text[] not null default '{}',
  created_at      timestamptz not null default now()
);

create index if not exists summaries_intake_idx on public.summaries (intake_id, created_at desc);

alter table public.intakes
  add constraint intakes_summary_fk
  foreign key (summary_id) references public.summaries(id) on delete set null;

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.intakes         enable row level security;
alter table public.messages        enable row level security;
alter table public.case_facts      enable row level security;
alter table public.risk_flags      enable row level security;
alter table public.lawyer_requests enable row level security;
alter table public.summaries       enable row level security;

-- Geen FORCE: zie de toelichting in 0100.

-- intakes ---------------------------------------------------------------------
create policy intakes_select_org on public.intakes
  for select to authenticated
  using (app.has_org_access(organization_id) and deleted_at is null);

create policy intakes_update_staff on public.intakes
  for update to authenticated
  using (app.has_org_role(organization_id, 'INTAKE_STAFF'))
  with check (app.has_org_role(organization_id, 'INTAKE_STAFF'));

create policy intakes_delete_admin on public.intakes
  for delete to authenticated
  using (app.has_org_role(organization_id, 'ORG_ADMIN'));

-- Bewust GEEN insert-policy: nieuwe intakes ontstaan uitsluitend via
-- app.create_public_intake() (0600), met rate limiting en consent in dezelfde transactie.

-- kindtabellen ----------------------------------------------------------------
-- Leesrecht volgt de intake; schrijfrecht is per tabel bewust smaller.

create policy messages_select_org on public.messages
  for select to authenticated
  using (app.has_org_access(organization_id));

create policy case_facts_select_org on public.case_facts
  for select to authenticated
  using (app.has_org_access(organization_id));

-- De advocaat mag een feit corrigeren; dat is de enige directe schrijfweg naar
-- case_facts voor mensen. AI-extractie loopt via RPC.
create policy case_facts_upsert_lawyer on public.case_facts
  for insert to authenticated
  with check (app.has_org_role(organization_id, 'LAWYER') and source = 'lawyer_input');

create policy case_facts_update_lawyer on public.case_facts
  for update to authenticated
  using (app.has_org_role(organization_id, 'LAWYER'))
  with check (app.has_org_role(organization_id, 'LAWYER'));

create policy risk_flags_select_org on public.risk_flags
  for select to authenticated
  using (app.has_org_access(organization_id));

create policy risk_flags_resolve_lawyer on public.risk_flags
  for update to authenticated
  using (app.has_org_role(organization_id, 'LAWYER'))
  with check (app.has_org_role(organization_id, 'LAWYER'));

create policy lawyer_requests_select_org on public.lawyer_requests
  for select to authenticated
  using (app.has_org_access(organization_id));

create policy lawyer_requests_insert_lawyer on public.lawyer_requests
  for insert to authenticated
  with check (
    app.has_org_role(organization_id, 'LAWYER')
    and requested_by = app.current_user_id()
  );

create policy lawyer_requests_update_lawyer on public.lawyer_requests
  for update to authenticated
  using (app.has_org_role(organization_id, 'LAWYER'))
  with check (app.has_org_role(organization_id, 'LAWYER'));

create policy summaries_select_org on public.summaries
  for select to authenticated
  using (app.has_org_access(organization_id));
