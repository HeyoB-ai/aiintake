-- =============================================================================
-- 20260828140000  Roteren van het workergeheim
-- =============================================================================
--
-- `retire_worker_secret(p_id)` bestond al, maar dat id is nergens op te vragen:
-- `app.worker_credentials` staat in het interne schema en PostgREST exposeert dat niet.
-- Intrekken was daarmee in de praktijk onmogelijk, en een rotatie die niet af te maken is,
-- wordt niet uitgevoerd.
--
-- Deze migratie is veilig op elk moment toe te passen: hij voegt alleen een functie toe en
-- verandert niets aan wat er al draait.
--
-- -----------------------------------------------------------------------------
-- Waarom "trek alles in behalve deze" en niet "trek deze in"
-- -----------------------------------------------------------------------------
-- De volgorde van een rotatie is niet vrij:
--
--   1. nieuw geheim zetten          (twee actief)
--   2. bij de worker zetten, uitrollen, banner controleren
--   3. het oude intrekken           (weer één actief)
--
-- Bij stap 3 weet je wélk geheim moet blijven — dat heb je net uitgerold. Wat er verder nog
-- actief is, hoort weg, en of dat er één is of drie doet er niet toe. Vragen om het id van
-- het oude geheim zou betekenen dat je eerst moet opzoeken wat je wilt wegdoen, en dat is
-- precies de stap die bij een rotatie blijft liggen.
--
-- De hash gaat erin, nooit het geheim zelf. De hash is niet geheim: hij staat al in de
-- database en er valt niets uit terug te rekenen.
create or replace function public.retire_other_worker_secrets(p_keep_hash text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_aantal int;
begin
  if p_keep_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'verwacht een hex-gecodeerde SHA-256 van 64 tekens';
  end if;

  -- Weigeren als het geheim dat moet blijven er niet is. Anders trekt een typefout in de
  -- hash álles in, en dan ligt de dienst stil met een foutmelding over sessietokens.
  if not exists (
    select 1 from app.worker_credentials
    where secret_hash = p_keep_hash and retired_at is null
  ) then
    raise exception 'het geheim dat moet blijven is niet actief; er wordt niets ingetrokken';
  end if;

  update app.worker_credentials
     set retired_at = now()
   where retired_at is null
     and secret_hash <> p_keep_hash;

  get diagnostics v_aantal = row_count;
  return v_aantal;
end;
$$;

revoke all on function public.retire_other_worker_secrets(text) from public, anon, authenticated;
grant execute on function public.retire_other_worker_secrets(text) to service_role;
