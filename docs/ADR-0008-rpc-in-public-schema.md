# ADR-0008 — Client-gerichte RPC's in `public`, `app` blijft intern

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0

## Context

Bij de eerste echte run van de isolatiesuite tegen een Supabase-project sloegen alle
cross-tenant-tests aan — RLS doet wat het moet — maar vier tests faalden op:

```
PGRST106 — Invalid schema: app
hint: Only the following schemas are exposed: public, graphql_public
```

Alle RPC's stonden in het `app`-schema, en PostgREST exposeert dat niet. Vijftien
verdere tests vielen om als gevolg: hun `beforeAll` kon geen sessie uitgeven.

Twee routes:

- **A.** `app` exposen via de API-instellingen.
- **B.** De client-gerichte RPC's naar `public` verplaatsen en `app` reserveren voor
  interne helpers.

## Besluit: B

### Waarom, in volgorde van gewicht

**1. A vereist configuratie die niet in versiebeheer zit.** "Exposed schemas" is op een
gehost project een dashboardinstelling. `supabase/config.toml` regelt alleen lokale
ontwikkeling. Een nieuw project — een tweede omgeving, een staging, een klant met een
eigen instance — komt dan met een schema dat niet geëxposeerd is en een applicatie die
overal PGRST106 geeft, terwijl de migraties compleet zijn en `db push` slaagt.

Dat is dezelfde klasse fout als de migratievolgorde die we net hebben gerepareerd:
gedrag dat afhangt van de toestand van de omgeving in plaats van van de repository. Bij
B is de standaardwaarde al goed en hoeft er niets te worden ingesteld.

**2. B geeft het kleinste oppervlak, en wel structureel.** Bij A staan interne helpers
en publieke RPC's in hetzelfde geëxposeerde schema. Wat bereikbaar is, hangt dan
volledig af van EXECUTE-grants — één vergeten `revoke` en `app.assert_agent_scope` of
`app.check_and_bump_rate_limit` is over HTTP aan te roepen.

Bij B is het onderscheid structureel: 14 helpers staan in `app`, dat PostgREST niet
kent, en zijn daardoor **onbereikbaar ongeacht welke grants erop staan**. De grants zijn
dan de tweede laag, niet de enige.

De uitkomst is meetbaar: 14 functies in `app` (onbereikbaar), 11 in `public`
aanroepbaar door `anon`, 3 alleen door `service_role`.

**3. Het maakt "wat is ons API-oppervlak" een beantwoordbare vraag.** Bij A is het
antwoord "alles in twee schema's waarvoor een grant bestaat". Bij B is het één lijst,
die in CI wordt gecontroleerd (zie hieronder).

### Wat A wél voor zich had

Nul codewijzigingen. Dat is echt iets waard, maar het weegt niet op tegen een instelling
die per omgeving handmatig gezet moet worden.

## Gevolgen voor de `search_path`-hardening

**Geen.** Elke functie houdt `set search_path = ''` en kwalificeert alles volledig
(`public.intakes`, niet `intakes`). Dat was al zo en moest al zo, want met een lege
`search_path` lost niets impliciet op.

Eén ding dat níét verandert en het vermelden waard is: de reden voor de hardening is
schema-capture voorkomen — een aanvaller met CREATE-rechten op een schema dat eerder in
het pad staat. Die reden is identiek in `public` en in `app`. Een functie in `public`
met `search_path = ''` is precies zo hard als dezelfde functie in `app`.

De SECURITY DEFINER functies in `public` roepen helpers in `app` aan
(`app.assert_agent_scope`, `app.check_and_bump_rate_limit`). Dat werkt omdat de body
draait als de definer, die USAGE op `app` heeft. De aanroeper heeft die rechten niet
nodig.

## Gevolgen voor de EXECUTE-grants

**Hier zit het echte werk, en een valkuil.**

Twee defaults werken tegen ons:

1. Postgres geeft nieuwe functies EXECUTE aan `PUBLIC`.
2. Supabase zet op elk project
   `alter default privileges in schema public grant all on functions to anon, authenticated, service_role`.

Gevolg: **een nieuwe functie in `public` is meteen door `anon` aan te roepen**, en `anon`
is de rol achter de publishable key — een sleutel die publiek is. Vergeet je de
`revoke`, dan staat je functie op internet.

In `app` was dat minder acuut, simpelweg omdat het schema onbereikbaar was. Dat is de
prijs van B, en die is te betalen mits mechanisch afgedwongen.

Daarom heeft elke functie in `public` nu een expliciete `revoke all ... from public`
vóór de `grant`, en voor de drie service-role-functies ook `from anon, authenticated`.
Het rechtenblok in migratie 0600 is daarmee de complete beschrijving van het
API-oppervlak.

### Bewaking

`scripts/check-migrations.mjs` vraagt na het migreren op welke functies in `public` door
`anon` aanroepbaar zijn en vergelijkt dat met een allowlist. Een functie die er onbedoeld
bij komt, laat de CI falen — met de melding welke `revoke` ontbreekt. Ook controleert hij
dat er geen `agent_*` of `create_public_intake` in `app` is blijven staan.

`supabase/tests/bootstrap.sql` zet dezelfde default privileges als Supabase. Zonder dat
zou de check lokaal groen zijn en het probleem alleen op een echt project optreden — de
test moet de valkuil reproduceren, niet omzeilen.

Geverifieerd door een functie zonder `revoke` toe te voegen: de check faalde met
`onbedoeld bereikbaar voor anon: per_ongeluk_publiek`. Daarmee is meteen aangetoond dat
de bootstrap de Supabase-default echt nabootst.

## Wat er verhuisd is

| Naar `public` (11 voor anon, 3 voor service_role)                                                     | Blijft in `app` (14, onbereikbaar over HTTP)                                          |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `create_public_intake`, `public_org_by_slug`                                                          | `jwt`, `current_user_id`, `role_rank`                                                 |
| de negen `agent_*` functies                                                                           | `is_super_admin`, `org_ids`, `has_org_access`, `has_org_role`                         |
| `issue_agent_session`, `revoke_agent_session`, `purge_expired_session_tokens` (alleen `service_role`) | `assert_agent_scope`, `hash_session_token`, `check_and_bump_rate_limit`               |
|                                                                                                       | `touch_updated_at`, `handle_new_auth_user`, `log_intake_status_change`, `write_audit` |

`anon` en `authenticated` houden USAGE op `app`: RLS-policies roepen
`app.has_org_access()` aan en policy-expressies draaien met de rechten van de
bevragende gebruiker. **USAGE is geen exposure** — of PostgREST een schema aanbiedt,
staat los van de grants erop.

## Openstaand

Geen. Er zijn geen dashboardinstellingen nodig: `public` is standaard geëxposeerd.
