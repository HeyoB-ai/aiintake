-- De tijdzone van het kantoor.
--
-- Waarom een kolom en geen constante in de code: een Belgisch of Duits kantoor zit
-- toevallig in dezelfde zone als een Nederlands, maar dat is een eigenschap van het
-- kantoor. Zodra er één kantoor buiten die zone bij komt, is een hardgecodeerde waarde
-- een stille fout in plaats van een instelling.
--
-- Waar het op uitkomt:
--
--   1. De groet in de openingsbeurt hangt van het lokale uur af.
--   2. Belangrijker: het ankerpunt waarmee de extractie relatieve tijdsaanduidingen
--      omrekent. De worker draait op UTC; tussen middernacht en twee uur 's nachts
--      (zomertijd) is de UTC-datum een dag eerder dan de Nederlandse. Een cliënt die om
--      half één 's nachts "gisteren" zegt, kreeg dan eergisteren in case_facts.
--
-- De check is bewust ruw. Postgres kent de volledige lijst in pg_timezone_names, maar die
-- als foreign key gebruiken zou een migratie laten falen op een Postgres met een andere
-- tzdata-versie. Een lege of onzinnige waarde vangen we hier af; of de zone bestaat,
-- controleert de applicatie bij het opstarten — daar is de fout ook leesbaar.
alter table public.organizations
  add column if not exists time_zone text not null default 'Europe/Amsterdam'
    check (time_zone ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$');

comment on column public.organizations.time_zone is
  'IANA-tijdzone van het kantoor. Bepaalt de groet en het datumanker voor de extractie.';
