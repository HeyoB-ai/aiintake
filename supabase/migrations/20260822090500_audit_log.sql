-- =============================================================================
-- 0500  Auditlog
-- =============================================================================
-- Append-only. Geen update-, geen delete-policy — ook niet voor ORG_ADMIN. Een
-- auditlog die de beheerder kan bewerken is geen auditlog.
--
-- Geen persoonsgegevens in dit log (§14): wel intake-id's en entiteits-id's, geen
-- namen, geen transcriptfragmenten, geen documentinhoud.
-- =============================================================================

create table if not exists public.audit_log (
  id              bigserial primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,

  action          text not null check (action in (
                    'intake.created','intake.status_changed','intake.assigned','intake.viewed',
                    'intake.exported','intake.deleted',
                    'session.started','session.ended',
                    'document.uploaded','document.downloaded','document.deleted',
                    'summary.generated','summary.flagged_for_review',
                    'lawyer_request.created','consent.recorded',
                    'user.invited','user.role_changed','user.removed',
                    'org.settings_changed','retention.purged')),

  actor_user_id   uuid references public.users(id) on delete set null,
  -- 'user' | 'agent' | 'system' — wie handelde er, als het geen mens was?
  actor_type      text not null default 'user' check (actor_type in ('user','agent','system','client')),

  entity_type     text not null,
  entity_id       uuid,
  intake_id       uuid references public.intakes(id) on delete cascade,

  -- Uitsluitend niet-identificerende context: oude/nieuwe status, aantallen, redenen.
  metadata        jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now()
);

create index if not exists audit_log_org_idx on public.audit_log (organization_id, created_at desc);
create index if not exists audit_log_intake_idx on public.audit_log (intake_id, created_at desc);
create index if not exists audit_log_action_idx on public.audit_log (organization_id, action, created_at desc);

alter table public.audit_log enable row level security;
-- Geen FORCE: zie de toelichting in 0100. app.write_audit() is SECURITY DEFINER en
-- zou er anders op stuklopen.

create policy audit_log_select_org on public.audit_log
  for select to authenticated
  using (app.has_org_access(organization_id));

-- Geen insert-policy: schrijven gebeurt uitsluitend via app.write_audit(), zodat
-- niemand een gebeurtenis kan vervalsen met een gekozen actor of tijdstip.
-- Geen update- of delete-policy: het log is onveranderlijk.

create or replace function app.write_audit(
  p_organization_id uuid,
  p_action          text,
  p_entity_type     text,
  p_entity_id       uuid default null,
  p_intake_id       uuid default null,
  p_actor_type      text default 'user',
  p_metadata        jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into public.audit_log (
    organization_id, action, actor_user_id, actor_type,
    entity_type, entity_id, intake_id, metadata
  )
  values (
    p_organization_id, p_action, app.current_user_id(), p_actor_type,
    p_entity_type, p_entity_id, p_intake_id, coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function app.write_audit(uuid, text, text, uuid, uuid, text, jsonb) from public;
grant execute on function app.write_audit(uuid, text, text, uuid, uuid, text, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Statuswijzigingen loggen zichzelf
-- -----------------------------------------------------------------------------
-- Doe je dit in de applicatielaag, dan mist er ooit een pad. In een trigger niet.
create or replace function app.log_intake_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    insert into public.audit_log (
      organization_id, action, actor_user_id, actor_type,
      entity_type, entity_id, intake_id, metadata
    )
    values (
      new.organization_id, 'intake.status_changed', app.current_user_id(),
      -- Er hoort geen mens bij een statuswijziging die de worker doet: die draait op
      -- de publishable key zonder ingelogde gebruiker. Is er wél een `sub` in het
      -- JWT, dan handelde een medewerker.
      case when app.current_user_id() is null then 'agent' else 'user' end,
      'intake', new.id, new.id,
      jsonb_build_object('from', old.status, 'to', new.status)
    );
  end if;

  if new.assigned_to is distinct from old.assigned_to and new.assigned_to is not null then
    insert into public.audit_log (
      organization_id, action, actor_user_id, actor_type,
      entity_type, entity_id, intake_id, metadata
    )
    values (
      new.organization_id, 'intake.assigned', app.current_user_id(), 'user',
      'intake', new.id, new.id,
      jsonb_build_object('assigned_to', new.assigned_to)
    );
  end if;

  return new;
end;
$$;

create trigger intakes_audit_status
  after update on public.intakes
  for each row execute function app.log_intake_status_change();
