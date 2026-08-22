# ADR-0007 — Het agent-sessietoken is ondoorzichtig, geen JWT

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0
**Vervangt:** het JWT-mechanisme uit [ADR-0002](ADR-0002-agent-zonder-service-role-key.md)
(het principe daarvan blijft ongewijzigd, alleen de uitvoering verandert)

## Context

[ADR-0002](ADR-0002-agent-zonder-service-role-key.md) legt vast dat de agent-worker
geen sleutel krijgt die RLS omzeilt, maar per sessie een credential dat aan één intake
is gebonden. De eerste uitvoering daarvan was een zelf ondertekend HS256-JWT met claim
`intake_id`, dat als `Authorization: Bearer` meeging en door PostgREST werd geverifieerd;
de RPC's lazen de claim uit `request.jwt.claims`.

Dat werkt niet in dit project, om een reden die zwaarder weegt dan een ontbrekende
omgevingsvariabele.

Wij gebruiken de nieuwe Supabase API-keys (`sb_publishable_...` / `sb_secret_...`) en
daarmee **asymmetrische JWT signing keys**. PostgREST verifieert een bearer token dan
tegen de JWKS van het project, en de bijbehorende private key zit in Supabase Auth.
Wij kunnen dus geen token maken dat PostgREST accepteert: elk zelfgemaakt token levert
401 op vóórdat er ook maar een RPC draait. Er is geen gedeeld HS256-secret om te
gebruiken, en het legacy-secret dat er ooit was, verdwijnt eind 2026 sowieso.

De consequentie geldt voor élke variant: **het token kan niet in de
Authorization-header.** Het moet als expliciete RPC-parameter reizen en door onze eigen
code worden geverifieerd.

## Overwogen

### B — eigen secret (`AGENT_JWT_SECRET`), handtekening geverifieerd in de RPC

Zelf een HS256-token ondertekenen met een secret dat we beheren, meesturen als
parameter, en in plpgsql verifiëren.

Afgevallen:

- **De handtekening koopt niets meer.** Het aantrekkelijke aan een JWT was dat PostgREST
  hem verifieerde en wij niets hoefden te doen. Zodra het token toch als parameter
  reist en wij toch code schrijven om hem te controleren, blijft er van dat voordeel
  niets over — alleen de complexiteit.
- **Handgeschreven crypto in SQL.** Base64url decoderen, JSON parsen, HMAC berekenen met
  `pgcrypto`, in constante tijd vergelijken en `exp` controleren, allemaal in plpgsql.
  Dat is precies het soort code dat niemand goed reviewt en waar een subtiele fout
  jarenlang onopgemerkt blijft.
- **Het secret moet in de database bereikbaar zijn**, dus in Vault of in een tabel. Dat
  is een nieuwe sleutel om te beheren en te roteren, met precies het bereik dat we
  wilden vermijden: wie hem heeft, mint tokens voor elke intake.
- **Niet intrekbaar.** Een uitgegeven JWT is geldig tot zijn `exp`, wat er daarna ook
  gebeurt.

### C — ondoorzichtig token, gehasht in `session_tokens`, RPC doet een lookup — **gekozen**

## Besluit

Een ondoorzichtig token van 32 willekeurige bytes (base64url, 43 tekens).
`public.session_tokens` bewaart alleen de SHA-256 daarvan, samen met `intake_id`,
`session_id`, `expires_at` en `revoked_at`. Elke `app.agent_*` RPC begint met
`app.assert_agent_scope(p_session_token, p_intake_id)`, die opzoekt, de vier
weigergronden afhandelt en de organisatie en sessie teruggeeft.

Uitgifte gebeurt in `apps/web` op de secret key: het ruwe token wordt daar gegenereerd,
alleen de hash gaat de database in, en het ruwe token gaat rechtstreeks door naar de
worker. **De database ziet het ruwe token nooit.** De worker kan er zelf geen aanmaken —
`app.issue_agent_session()` is alleen aan `service_role` gegrant.

## Waarom dit beter is dan alleen "het werkt wel"

- **Intrekbaar.** `app.agent_end_session()` zet `revoked_at` zodra de sessie eindigt, en
  dat is meestal ruim vóór de TTL. Precies dat gat is waar een gelekt token anders nog
  bruikbaar zou zijn. Daarnaast is er `app.revoke_agent_session()` voor het geval een
  worker vastloopt of een token lekt.
- **Gehasht opgeslagen.** Wie leestoegang tot de tabel krijgt — via een backup, een dump,
  een verkeerd gerichte policy — heeft nog steeds geen werkend token.
- **Geen crypto om zelf te schrijven.** Eén `digest()` aan beide kanten, en een lookup op
  een geïndexeerde kolom.
- **De sessie zit in het token.** `p_session_id` is uit alle RPC's verdwenen: de sessie
  wordt uit het token afgeleid. Een mismatch tussen token en sessie kan daardoor niet
  meer bestaan.
- **Zichtbaar gebruik.** `last_used_at` maakt een token dat nog gebruikt wordt nadat de
  sessie had moeten eindigen, achteraf vindbaar.

## Prijs

- **Een lookup per RPC.** In de praktijk verwaarloosbaar: elke agent-RPC is al een
  databaseronde, en dit is één extra indexprobe binnen dezelfde query.
- **`last_used_at` bijwerken is een schrijfactie.** Daarom grofmazig: hooguit eens per
  minuut, zodat de hele beurtcyclus niet op één rij gaat duwen. De prijs daarvan is dat
  het veld een indicatie is en geen exacte teller — expliciet zo bedoeld.
- **`session_tokens` groeit.** `app.purge_expired_session_tokens()` ruimt op; aanhaken op
  de retentie-cleanup in Fase 6.
- **Het token staat in de request body.** Bij POST-RPC's belandt het niet in URL's of
  access logs. Het blijft wel iets om niet te loggen: `RpcError` neemt daarom nooit de
  argumenten over in de melding.

## Verificatie

`packages/db/src/__tests__/tenant-isolation.test.ts` dekt het pad af: schrijven naar de
eigen intake, een token voor een andere intake, een token van het andere kantoor, een
verlopen token, een ingetrokken token, een token na sessie-einde, vijf soorten
onzintokens, het token als bearer-header (werkt niet, en dat is vastgelegd), uitgifte
door anon en door een ORG_ADMIN (beide geweigerd), aftopping van de TTL op de
sessieduur van het kantoor, en dat het ruwe token nergens is opgeslagen.

`packages/db/src/agent-token.test.ts` legt vast dat de TypeScript-kant een standaard
SHA-256 in hex produceert. Dat de SQL-kant hetzelfde doet, blijkt uit de eerste
isolatietest — lopen ze uit elkaar, dan valideert geen enkel token.

## Uitkomst

Bevestigd op 22 augustus 2026: 44/44 isolatie-assertions groen tegen het echte project.

Het faalscenario dat hier stond — `app.hash_session_token()` en `hashSessionToken()`
berekenen dezelfde hash op twee plekken, en bij afwijking valideert geen enkele sessie —
**heeft zich niet voorgedaan**. De twee komen overeen.

Dat blijft wel een koppeling om in de gaten te houden: er is geen mechanisme dat de twee
implementaties aan elkaar bindt, alleen een test die faalt als ze uiteenlopen. Verandert
er ooit iets aan de codering (base64url in plaats van hex, een pepper erbij), dan moet
dat aan beide kanten tegelijk.
