-- =============================================================================
-- 0300  Realtime sessies, latencymetriek, LLM-herleidbaarheid, prompts, consent
-- =============================================================================

-- -----------------------------------------------------------------------------
-- sessions  — één realtime sessie binnen een intake
-- -----------------------------------------------------------------------------
-- Een intake kan meerdere sessies hebben: de cliënt valt weg en komt terug, of de
-- advocaat vraagt om meer informatie en er volgt een tweede gesprek.
create table if not exists public.sessions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  intake_id         uuid not null references public.intakes(id) on delete cascade,

  channel           text not null check (channel in ('video','voice','chat')),
  room_name         text,
  avatar_provider   text check (avatar_provider in ('beyondpresence','anam','null')),
  avatar_session_id text,
  stt_provider      text,
  tts_provider      text,
  llm_model         text,

  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  end_reason        text check (end_reason in ('completed','client_left','timeout','error','budget')),
  billed_seconds    int check (billed_seconds >= 0),

  -- Prewarm start vóór "START INTAKE"; die seconden tellen wel mee in de facturatie
  -- van de avatarvendor en moeten dus zichtbaar zijn in de kostenanalyse (§7).
  prewarmed_at      timestamptz,

  created_at        timestamptz not null default now()
);

create index if not exists sessions_intake_idx on public.sessions (intake_id, started_at desc);
create index if not exists sessions_org_active_idx
  on public.sessions (organization_id) where ended_at is null;

alter table public.messages
  add constraint messages_session_fk
  foreign key (session_id) references public.sessions(id) on delete set null;

alter table public.lawyer_requests
  add constraint lawyer_requests_session_fk
  foreign key (asked_in_session) references public.sessions(id) on delete set null;

-- -----------------------------------------------------------------------------
-- session_tokens  — de credential van de agent-worker
-- -----------------------------------------------------------------------------
-- De worker krijgt geen sleutel die verder reikt dan één intake. Hij krijgt een
-- ondoorzichtig, willekeurig token van 256 bit; hier staat alleen de SHA-256 daarvan.
--
-- Waarom een hash en niet het token zelf: wie leestoegang tot deze tabel krijgt —
-- via een backup, een dump, een verkeerd gerichte policy — heeft dan nog steeds geen
-- werkend token. Dezelfde reden waarom je wachtwoorden niet in platte tekst bewaart.
--
-- Waarom geen JWT: zie docs/ADR-0007-agent-sessietoken.md. Kort: PostgREST verifieert
-- bij asymmetrische signing keys tegen de JWKS van het project, dus wij kunnen geen
-- token maken dat als bearer credential wordt geaccepteerd. En een opaque token is
-- intrekbaar; een JWT is dat niet.
create table if not exists public.session_tokens (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  intake_id       uuid not null references public.intakes(id) on delete cascade,
  session_id      uuid not null references public.sessions(id) on delete cascade,

  -- SHA-256 van het ruwe token, als hex. Het ruwe token bestaat maar op één moment:
  -- in het antwoord van app.issue_agent_session().
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),

  expires_at      timestamptz not null,
  -- Ingetrokken bij sessie-einde, of handmatig als er iets misgaat. Een JWT kun je
  -- niet intrekken; dit is het concrete voordeel van de lookup.
  revoked_at      timestamptz,
  -- Voor audit en voor het opsporen van een token dat nog gebruikt wordt nadat de
  -- sessie had moeten eindigen. Bewust grofmazig bijgewerkt (hooguit eens per
  -- minuut): een exacte teller zou een schrijfactie per RPC kosten op een rij waar
  -- de hele beurtcyclus overheen gaat.
  last_used_at    timestamptz,

  created_at      timestamptz not null default now()
);

-- De lookup bij elke agent-RPC gaat hier overheen. Partieel op nog-geldige tokens.
create index if not exists session_tokens_active_idx
  on public.session_tokens (token_hash)
  where revoked_at is null;

create index if not exists session_tokens_expiry_idx
  on public.session_tokens (expires_at);

create index if not exists session_tokens_session_idx
  on public.session_tokens (session_id);

comment on table public.session_tokens is
  'Hashes van agent-sessietokens. Geen enkele client leest of schrijft deze tabel rechtstreeks; alleen de functies in 0600.';

-- -----------------------------------------------------------------------------
-- session_metrics  — de latencybegroting per beurt
-- -----------------------------------------------------------------------------
-- Wegschrijven is geen luxe: zo zie je regressies over releases heen in plaats van
-- ze te voelen tijdens een demo.
create table if not exists public.session_metrics (
  id                             uuid primary key default gen_random_uuid(),
  session_id                     uuid not null references public.sessions(id) on delete cascade,
  turn_index                     int not null,

  speech_end_to_stt_final_ms     int check (speech_end_to_stt_final_ms >= 0),
  stt_to_llm_first_token_ms      int check (stt_to_llm_first_token_ms >= 0),
  llm_to_tts_first_audio_ms      int check (llm_to_tts_first_audio_ms >= 0),
  tts_to_avatar_first_frame_ms   int check (tts_to_avatar_first_frame_ms >= 0),
  total_response_latency_ms      int check (total_response_latency_ms >= 0),
  interrupt_to_silence_ms        int check (interrupt_to_silence_ms >= 0),
  was_interrupted                boolean not null default false,

  created_at                     timestamptz not null default now(),
  unique (session_id, turn_index)
);

create index if not exists session_metrics_session_idx on public.session_metrics (session_id, turn_index);

-- -----------------------------------------------------------------------------
-- prompt_templates / prompt_versions
-- -----------------------------------------------------------------------------
-- Elke AI-uitspraak is herleidbaar tot een exacte promptversie. Zonder dit kun je
-- achteraf niet verklaren waarom het systeem iets zei.
create table if not exists public.prompt_templates (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  purpose     text not null check (purpose in ('conversation','extraction','urgency','document','summary')),
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists public.prompt_versions (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.prompt_templates(id) on delete cascade,
  version     int not null,
  body        text not null,
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (template_id, version)
);

-- Precies één actieve versie per template.
create unique index if not exists prompt_versions_one_active
  on public.prompt_versions (template_id) where active;

-- -----------------------------------------------------------------------------
-- llm_calls  — herleidbaarheid van elke AI-uitspraak
-- -----------------------------------------------------------------------------
create table if not exists public.llm_calls (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  intake_id          uuid references public.intakes(id) on delete cascade,
  session_id         uuid references public.sessions(id) on delete set null,

  purpose            text not null check (purpose in ('conversation','extraction','urgency','document','summary')),
  model              text not null,
  prompt_template_id uuid references public.prompt_templates(id) on delete set null,
  prompt_version     int,

  input_tokens       int check (input_tokens >= 0),
  output_tokens      int check (output_tokens >= 0),
  latency_ms         int check (latency_ms >= 0),
  schema_valid       boolean,
  repair_attempts    int not null default 0 check (repair_attempts >= 0),

  created_at         timestamptz not null default now()
);

create index if not exists llm_calls_intake_idx on public.llm_calls (intake_id, created_at desc);
create index if not exists llm_calls_org_cost_idx on public.llm_calls (organization_id, created_at desc);

alter table public.messages
  add constraint messages_llm_call_fk
  foreign key (llm_call_id) references public.llm_calls(id) on delete set null;

alter table public.case_facts
  add constraint case_facts_llm_call_fk
  foreign key (llm_call_id) references public.llm_calls(id) on delete set null;

alter table public.summaries
  add constraint summaries_llm_call_fk
  foreign key (llm_call_id) references public.llm_calls(id) on delete set null;

-- -----------------------------------------------------------------------------
-- consent_records
-- -----------------------------------------------------------------------------
-- AI-disclosure en privacy-acceptatie apart vastleggen, met versienummers van beide
-- teksten (§8.7 architectuurdoc). Achteraf moet aantoonbaar zijn wélke tekst iemand
-- heeft gezien.
create table if not exists public.consent_records (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  intake_id              uuid not null references public.intakes(id) on delete cascade,

  privacy_accepted       boolean not null default false,
  privacy_policy_version text not null,
  ai_disclosure_accepted boolean not null default false,
  ai_disclosure_version  text not null,

  camera_consent         boolean not null default false,
  microphone_consent     boolean not null default false,
  recording_consent      boolean not null default false,

  accepted_at            timestamptz not null default now(),
  -- Gehasht, niet ruw: de user agent is op zichzelf een identificerend gegeven.
  user_agent_hash        text,

  created_at             timestamptz not null default now()
);

create index if not exists consent_records_intake_idx on public.consent_records (intake_id);

-- -----------------------------------------------------------------------------
-- rate limiting op de publieke intakeroute
-- -----------------------------------------------------------------------------
-- Elke sessie kost geld vanaf de eerste seconde (§8.5). Deze tabel telt pogingen per
-- IP-hash én per organisatie; app.create_public_intake() weigert boven de drempel.
create table if not exists public.intake_rate_limits (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- Gehasht met een server-side pepper; nooit het ruwe IP-adres opslaan.
  ip_hash         text not null,
  window_start    timestamptz not null default date_trunc('hour', now()),
  attempts        int not null default 1,
  unique (organization_id, ip_hash, window_start)
);

create index if not exists intake_rate_limits_window_idx
  on public.intake_rate_limits (window_start);

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.sessions            enable row level security;
alter table public.session_tokens      enable row level security;
alter table public.session_metrics     enable row level security;
alter table public.prompt_templates    enable row level security;
alter table public.prompt_versions     enable row level security;
alter table public.llm_calls           enable row level security;
alter table public.consent_records     enable row level security;
alter table public.intake_rate_limits  enable row level security;

-- Geen FORCE: zie de toelichting in 0100.

create policy sessions_select_org on public.sessions
  for select to authenticated
  using (app.has_org_access(organization_id));

create policy session_metrics_select_org on public.session_metrics
  for select to authenticated
  using (
    exists (
      select 1 from public.sessions s
      where s.id = session_metrics.session_id
        and app.has_org_access(s.organization_id)
    )
  );

create policy llm_calls_select_org on public.llm_calls
  for select to authenticated
  using (app.has_org_access(organization_id));

create policy consent_records_select_org on public.consent_records
  for select to authenticated
  using (app.has_org_access(organization_id));

-- Prompts zijn productconfiguratie, niet tenantdata: leesbaar voor elke ingelogde
-- gebruiker, schrijfbaar alleen voor super admins.
create policy prompt_templates_select on public.prompt_templates
  for select to authenticated using (true);

create policy prompt_versions_select on public.prompt_versions
  for select to authenticated using (true);

create policy prompt_templates_write_super on public.prompt_templates
  for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());

create policy prompt_versions_write_super on public.prompt_versions
  for all to authenticated
  using (app.is_super_admin()) with check (app.is_super_admin());

-- intake_rate_limits is puur infrastructuur: geen enkele client leest of schrijft
-- hem rechtstreeks. Er staat bewust geen policy — alleen de RPC's in 0600 raken hem.

-- session_tokens krijgt bewust ook geen enkele policy, ook geen select voor
-- ORG_ADMIN. Er is geen legitieme reden voor een client om zelfs maar de hashes te
-- zien, en "we tonen alleen de hash" is een geruststelling die je niet nodig hebt als
-- niemand erbij kan. Wat een kantoor wél moet kunnen zien — welke sessies er liepen
-- en hoe lang — staat in public.sessions.
