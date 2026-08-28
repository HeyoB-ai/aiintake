-- =============================================================================
-- 20260828120000  Het workergeheim — de tweede factor (deel 1 van 2)
-- =============================================================================
--
-- Zie RISICOS.md risico 31. De agent-RPC's zijn verleend aan `anon`, en de browser van
-- de cliënt heeft de publiceerbare sleutel én het sessietoken. Daarmee kan een cliënt
-- vandaag een assistent-beurt in zijn eigen dossier schrijven die achteraf niet van een
-- echte beurt te onderscheiden is.
--
-- Dat is geen slordige grant: de worker draait op de publiceerbare sleutel omdat
-- ADR-0002 hem geen service-role key gunt, en zijn rol is daarmee `anon` — dezelfde als
-- die van de browser. Zie ADR-0002 en ADR-0007.
--
-- -----------------------------------------------------------------------------
-- Waarom een geheim en geen eigen databaserol
-- -----------------------------------------------------------------------------
-- Een eigen rol zou het netst zijn: `revoke ... from anon`, `grant ... to intake_worker`,
-- en de worker draagt een JWT met die rol. Dat kan hier niet. Dit project draait op de
-- nieuwe API-sleutels en dus op asymmetrische JWT signing keys; de JWKS levert alleen een
-- publieke verify-sleutel (ES256) en de private key zit bij Supabase. Wij kunnen geen
-- token tekenen dat PostgREST als bearer accepteert. Dat staat al in
-- packages/db/src/agent-token.ts en het is de reden dat het sessietoken opaque is.
--
-- -----------------------------------------------------------------------------
-- Waarom een header en geen extra parameter
-- -----------------------------------------------------------------------------
-- Als parameter zou het geheim aan tien functiehandtekeningen moeten worden toegevoegd,
-- met alle aanroepers, de rechtenblokken en de allowlist mee. Als header verandert er
-- één functie: `app.assert_agent_scope`, die elke agent-functie toch al als eerste regel
-- aanroept.
--
-- Veiligheid kost dat niets. Een header is niet zwakker dan een parameter: allebei
-- reizen ze over TLS in hetzelfde verzoek, en een cliënt kan allebei zetten. Wat een
-- cliënt niet heeft, is de waarde — en dat is het hele punt.
--
-- -----------------------------------------------------------------------------
-- Deel 1 van 2, en de volgorde is niet vrijblijvend
-- -----------------------------------------------------------------------------
-- Deze migratie legt alleen aan: de tabel, het zetten van het geheim, en een functie
-- waarmee de worker kan vragen of hij herkend wordt. Er wordt nog niets afgedwongen.
--
-- Afdwingen gebeurt in 20260828120100. Zou dat hier gebeuren, dan weigert de database
-- elke schrijfactie van de worker vanaf het moment van pushen tot het moment dat het
-- geheim is gezet én de worker opnieuw is uitgerold — en dat is een storing van
-- minuten tot uren, midden in gesprekken.
--
-- De volgorde:
--
--   1. push deze migratie
--   2. `node scripts/set-worker-secret.mjs` — genereert het geheim en slaat de hash op
--   3. zet AGENT_WORKER_SECRET bij de worker (Railway) en rol hem uit
--   4. controleer dat de worker bij het opstarten "workergeheim: herkend" meldt
--   5. push 20260828120100
--
-- =============================================================================

-- -----------------------------------------------------------------------------
-- De credentials
-- -----------------------------------------------------------------------------
-- Meerdere actieve rijen zijn toegestaan, en dat is de hele rotatiestrategie: zet een
-- tweede geheim, rol de worker uit, trek het eerste in. Zonder overlap zou roteren een
-- onderbreking betekenen, en dan wordt er niet geroteerd.
create table if not exists app.worker_credentials (
  id          uuid primary key default gen_random_uuid(),
  -- Hex-gecodeerde SHA-256, net als session_tokens. De database ziet het geheim nooit.
  secret_hash text not null unique,
  -- Waar dit geheim vandaan komt, voor als er twee actief zijn ("railway-productie").
  label       text not null,
  created_at  timestamptz not null default now(),
  retired_at  timestamptz
);

alter table app.worker_credentials enable row level security;
-- Geen enkele policy: niemand komt er via PostgREST bij. De functies hieronder zijn
-- security definer en lezen de tabel namens de eigenaar.

-- -----------------------------------------------------------------------------
-- Herkent de database de aanroeper als de worker?
-- -----------------------------------------------------------------------------
-- `request.headers` wordt door PostgREST per verzoek gezet. De tweede parameter van
-- current_setting is `missing_ok`: buiten een PostgREST-verzoek (psql, een migratie)
-- bestaat de instelling niet en is het antwoord false — niet een fout.
create or replace function app.worker_herkend()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_geheim text;
begin
  v_geheim := nullif(
    current_setting('request.headers', true)::json ->> 'x-agent-worker-secret',
    ''
  );
  if v_geheim is null then
    return false;
  end if;

  return exists (
    select 1 from app.worker_credentials c
    where c.secret_hash = app.hash_session_token(v_geheim)
      and c.retired_at is null
  );
exception
  -- Geen JSON in request.headers (kan buiten PostgREST). Dan is er geen worker.
  when others then return false;
end;
$$;

-- -----------------------------------------------------------------------------
-- De zelfcontrole van de worker
-- -----------------------------------------------------------------------------
-- Bestaat zodat de worker bij het opstarten kan vaststellen dát hij herkend wordt, in
-- plaats van daar bij de eerste schrijfactie van een cliënt achter te komen. Zonder deze
-- functie is "het geheim staat verkeerd" een storing die pas midden in een gesprek
-- zichtbaar wordt, en dan als een mislukte feitschrijving.
--
-- Geeft alleen ja of nee. Geen namen, geen labels, geen aantallen: wie het geheim niet
-- heeft, hoort ook niet te weten hoeveel er actief zijn.
create or replace function public.agent_verify_worker()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.worker_herkend();
$$;

-- -----------------------------------------------------------------------------
-- Het geheim zetten en intrekken
-- -----------------------------------------------------------------------------
-- Alleen service_role, dus alleen vanuit apps/web of een operatorscript. De worker kan
-- zijn eigen credential niet aanmaken of verlengen — dezelfde regel als bij de
-- sessietokens (zie packages/db/src/agent-session.ts).
--
-- De hash gaat erin, nooit het geheim. Het ruwe geheim bestaat alleen in het geheugen
-- van het script dat het genereert en in de omgeving van de worker.
create or replace function public.set_worker_secret(
  p_secret_hash text,
  p_label       text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'verwacht een hex-gecodeerde SHA-256 van 64 tekens';
  end if;

  insert into app.worker_credentials (secret_hash, label)
  values (p_secret_hash, p_label)
  on conflict (secret_hash) do update set retired_at = null
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.retire_worker_secret(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update app.worker_credentials set retired_at = now() where id = p_id;
$$;

-- =============================================================================
-- written_by — wie heeft deze regel geschreven?
-- =============================================================================
-- Vandaag is niet te zien of een bericht door de worker of door een browser met een
-- geldig token is weggeschreven; de twee zijn byte voor byte gelijk. Dat is niet met
-- terugwerkende kracht te repareren, maar wél vanaf nu vast te leggen.
--
-- `session_id` helpt niet: die wordt binnen de functie uit het token afgeleid, dus een
-- browser met een geldig token krijgt hem net zo correct ingevuld.
--
-- De waarde wordt binnen de functie gezet, nooit uit een parameter. Een herkomst die de
-- aanroeper zelf mag opgeven, legt alleen vast wat hij beweert — en ziet er dan uit als
-- bewijs. Dat is erger dan geen kolom.
--
-- 'unknown' is de standaard en dus de waarde van alles wat er nu al staat. Dat is de
-- eerlijke stand: van die rijen weten we het niet.
alter table public.messages
  add column if not exists written_by text not null default 'unknown'
    check (written_by in ('agent', 'lawyer', 'import', 'unknown'));

alter table public.case_facts
  add column if not exists written_by text not null default 'unknown'
    check (written_by in ('agent', 'lawyer', 'import', 'unknown'));

comment on column public.messages.written_by is
  'Binnen de RPC gezet, nooit door de aanroeper. ''unknown'' = geschreven vóór risico 31.';
comment on column public.case_facts.written_by is
  'Binnen de RPC gezet, nooit door de aanroeper. ''unknown'' = geschreven vóór risico 31.';

-- =============================================================================
-- Rechten
-- =============================================================================
revoke all on function app.worker_herkend() from public;

-- De worker roept dit aan met de publiceerbare sleutel, dus anon moet erbij kunnen.
-- Er valt niets uit te lekken: het antwoord is ja of nee, en wie geen geheim stuurt
-- krijgt altijd nee.
revoke all on function public.agent_verify_worker() from public;
grant execute on function public.agent_verify_worker() to anon, authenticated;

-- Zetten en intrekken uitsluitend met de secret key.
revoke all on function public.set_worker_secret(text, text) from public, anon, authenticated;
grant execute on function public.set_worker_secret(text, text) to service_role;
revoke all on function public.retire_worker_secret(uuid) from public, anon, authenticated;
grant execute on function public.retire_worker_secret(uuid) to service_role;
