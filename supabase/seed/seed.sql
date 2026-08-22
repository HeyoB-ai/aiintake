-- =============================================================================
-- Demo-seed — Van Dijk Arbeidsrecht
-- =============================================================================
-- Draai dit tegen een ontwikkel- of demo-omgeving, nooit tegen productie.
--
--   psql "$DATABASE_URL" -f supabase/seed/seed.sql
--
-- Wat hier staat is het decor voor de demo (§12): het kantoor, de promptsjablonen en
-- vijf afgeronde intakes met uiteenlopende urgentieniveaus. Transcripten,
-- samenvattingen en documenten worden in Fase 7 toegevoegd, zodra het cold path en
-- de samenvattingsgenerator bestaan om ze te produceren — een handgeschreven
-- "samenvatting" in de seed zou een kwaliteit suggereren die het systeem nog niet
-- levert, en dat is precies het soort demo-illusie waar dit product niet op moet
-- drijven.
--
-- Gebruikers worden NIET geseed: die ontstaan via Supabase Auth. Koppel na het
-- aanmaken van een account je gebruiker aan het kantoor met het statement onderaan.
-- =============================================================================

begin;

-- Vaste id, zodat de seed idempotent is en je hem opnieuw kunt draaien.
insert into public.organizations (
  id, slug, name, default_language,
  provider_config, session_limits, intake_criteria, retention_policy,
  publish_client_video, privacy_policy_version, ai_disclosure_version
)
values (
  '00000000-0000-4000-a000-000000000001',
  'vandijk-arbeidsrecht',
  'Van Dijk Arbeidsrecht',
  'nl',
  jsonb_build_object(
    'avatar', 'null',            -- tot de bakeoff in Fase 1 is gedraaid
    'stt', 'deepgram',
    'tts', 'cartesia',
    'llmHot', 'claude-haiku-4-5-20251001',
    'llmCold', 'claude-sonnet-5'
  ),
  jsonb_build_object(
    'maxSessionMinutes', 25,
    'inactivityTimeoutSeconds', 90,
    'maxConcurrentSessions', 5,
    'monthlyBudgetEurCents', 50000,
    'fallbackToChatOnBudget', true
  ),
  jsonb_build_object(
    'minMonthlySalary', null,
    'acceptIfOtherCounsel', false,
    'autoFlagFrom', 'HIGH'
  ),
  jsonb_build_object(
    'mediaRetentionHours', 0,
    'transcriptRetentionDays', 365,
    'documentRetentionDays', 365,
    'visualSignalRetentionHours', 0,
    'rejectedIntakeRetentionDays', 90
  ),
  false,                          -- cliëntcamera wordt niet gepubliceerd; zie ADR-0004
  'v1',
  'v1'
)
on conflict (id) do update set name = excluded.name;

-- -----------------------------------------------------------------------------
-- Promptsjablonen
-- -----------------------------------------------------------------------------
-- De bodies worden in Fase 2 en 3 ingevuld. De registratie staat er nu al, zodat
-- llm_calls vanaf de eerste beurt naar een bestaand sjabloon kan verwijzen.
insert into public.prompt_templates (key, purpose, description) values
  ('conversation.employment.nl', 'conversation', 'Hot path — formuleert de gesproken zin. Platte tekst, nooit JSON.'),
  ('extraction.employment',      'extraction',   'Cold path — feiten met confidence en citaat uit het transcript.'),
  ('urgency.employment',         'urgency',      'Cold path — signaleert; de rule engine beslist.'),
  ('document.analysis',          'document',     'Cold path — documentinhoud als data, nooit als instructie.'),
  ('summary.employment',         'summary',      'Cold path — samenvatting met verwijzing per bewering.')
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- Vijf afgeronde demo-intakes
-- -----------------------------------------------------------------------------
with seeded as (
  select * from (values
    ('10000000-0000-4000-a000-000000000001'::uuid, 'Sanne Bakker',    'Vaststellingsovereenkomst met tekendeadline', 'HIGH',     0.850, 'READY_FOR_REVIEW'),
    ('10000000-0000-4000-a000-000000000002'::uuid, 'Mehmet Yilmaz',   'Ontslag op staande voet',                     'CRITICAL', 0.780, 'READY_FOR_REVIEW'),
    ('10000000-0000-4000-a000-000000000003'::uuid, 'Petra de Groot',  'Loon niet betaald sinds juni',                'MEDIUM',   0.720, 'READY_FOR_REVIEW'),
    ('10000000-0000-4000-a000-000000000004'::uuid, 'Johan Vermeer',   'Geschil over re-integratie',                  'MEDIUM',   0.690, 'READY_FOR_REVIEW'),
    ('10000000-0000-4000-a000-000000000005'::uuid, 'Aisha Nkemdirim', 'Tijdelijk contract loopt af',                 'LOW',      0.910, 'READY_FOR_REVIEW')
  ) as t(id, client_name, subject, urgency, completeness, status)
)
insert into public.intakes (
  id, organization_id, practice_area, language, status,
  client_name, subject, urgency_level, completeness,
  template_key, template_version, conflict_check_status,
  created_at, completed_at
)
select
  s.id,
  '00000000-0000-4000-a000-000000000001',
  'employment',
  'nl',
  s.status,
  s.client_name,
  s.subject,
  s.urgency,
  s.completeness,
  'employment.v1',
  1,
  'clear',
  now() - (row_number() over (order by s.id) * interval '9 hours'),
  now() - (row_number() over (order by s.id) * interval '9 hours') + interval '14 minutes'
from seeded s
on conflict (id) do nothing;

-- Feiten. Bewust met source_ref: de constraint case_facts_traceable weigert een
-- vastgesteld feit zonder herkomst, en de seed hoort zich aan dezelfde regel te
-- houden als de applicatie.
insert into public.case_facts (
  organization_id, intake_id, key, value, value_type, status, confidence, source, source_ref, evidence_quote
)
values
  -- 1. VSO met tekendeadline (HIGH)
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'primary_issue',        '"settlement_agreement"', 'enum',    'confirmed', 0.97, 'client_statement', 'seed', 'vaststellingsovereenkomst'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'termination_route',    '"settlement_agreement"', 'enum',    'confirmed', 0.96, 'client_statement', 'seed', 'vaststellingsovereenkomst'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'contract_type',        '"permanent"',            'enum',    'confirmed', 0.92, 'client_statement', 'seed', 'vast contract'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'gross_monthly_salary', '3800',                   'number',  'confirmed', 0.90, 'client_statement', 'seed', '3800 euro bruto'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'vso_signed',           'false',                  'boolean', 'confirmed', 0.95, 'client_statement', 'seed', 'nog niet getekend'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'vso_signing_deadline', to_jsonb(to_char(current_date + 3, 'YYYY-MM-DD')), 'date', 'confirmed', 0.88, 'client_statement', 'seed', 'vrijdag tekenen'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'currently_ill',        'false',                  'boolean', 'confirmed', 0.85, 'client_statement', 'seed', 'niet ziek'),
  -- "Niet vastgesteld" is een uitkomst, geen leegte. Daarom staat dit er expliciet in.
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'previous_warnings',    'null',                   'boolean', 'unknown',   0.00, 'client_statement', null,   null),

  -- 2. Ontslag op staande voet (CRITICAL)
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000002', 'primary_issue',        '"dismissal"',            'enum',    'confirmed', 0.98, 'client_statement', 'seed', 'op staande voet'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000002', 'termination_route',    '"summary_dismissal"',    'enum',    'confirmed', 0.97, 'client_statement', 'seed', 'op staande voet'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000002', 'summary_dismissal_date', to_jsonb(to_char(current_date - 5, 'YYYY-MM-DD')), 'date', 'confirmed', 0.93, 'client_statement', 'seed', 'vorige week woensdag'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000002', 'summary_dismissal_contested', 'false',           'boolean', 'confirmed', 0.90, 'client_statement', 'seed', 'nog geen bezwaar'),

  -- 3. Loonconflict (MEDIUM)
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000003', 'primary_issue',        '"wage"',                 'enum',    'confirmed', 0.95, 'client_statement', 'seed', 'loon niet betaald'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000003', 'wage_payment_stopped', 'true',                   'boolean', 'confirmed', 0.96, 'client_statement', 'seed', 'geen loon meer'),

  -- 4. Ziekte en re-integratie (MEDIUM)
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000004', 'primary_issue',        '"illness"',              'enum',    'confirmed', 0.94, 'client_statement', 'seed', 're-integratie'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000004', 'currently_ill',        'true',                   'boolean', 'confirmed', 0.95, 'client_statement', 'seed', 'ziek gemeld'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000004', 'occupational_doctor_involved', 'true',           'boolean', 'confirmed', 0.91, 'client_statement', 'seed', 'bedrijfsarts'),

  -- 5. Tijdelijk contract (LOW)
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000005', 'primary_issue',        '"dismissal"',            'enum',    'confirmed', 0.88, 'client_statement', 'seed', 'contract loopt af'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000005', 'contract_type',        '"fixed_term"',           'enum',    'confirmed', 0.95, 'client_statement', 'seed', 'tijdelijk contract'),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000005', 'fixed_term_contract_count', '3',                 'number',  'confirmed', 0.86, 'client_statement', 'seed', 'derde contract')
on conflict (intake_id, key) do nothing;

-- Risicovlaggen. `detected_by = 'rule'`: de regel is de bron van waarheid, AI mag
-- alleen signaleren.
insert into public.risk_flags (
  organization_id, intake_id, rule_key, level, label, detected_by, source_ref, independently_confirmed
)
values
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000001', 'vso_deadline_within_14_days', 'HIGH',     'Tekendeadline vaststellingsovereenkomst binnen 14 dagen', 'rule', 'seed', true),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000002', 'summary_dismissal',           'CRITICAL', 'Ontslag op staande voet — korte vervaltermijn',            'rule', 'seed', true),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000003', 'wage_payment_stopped',        'MEDIUM',   'Loonbetaling gestopt',                                    'rule', 'seed', true),
  ('00000000-0000-4000-a000-000000000001', '10000000-0000-4000-a000-000000000004', 'reintegration_dispute',       'MEDIUM',   'Mogelijk geschil over re-integratieverplichtingen',        'rule', 'seed', false)
on conflict (intake_id, rule_key) do nothing;

commit;

-- -----------------------------------------------------------------------------
-- Koppel je eigen account aan het demo-kantoor
-- -----------------------------------------------------------------------------
-- Maak eerst een gebruiker aan via Supabase Auth (Studio → Authentication →
-- Add user), en draai dan:
--
--   insert into public.organization_users (organization_id, user_id, role)
--   select '00000000-0000-4000-a000-000000000001', id, 'ORG_ADMIN'
--   from auth.users where email = 'jij@voorbeeld.nl'
--   on conflict (organization_id, user_id) do update set role = 'ORG_ADMIN';
