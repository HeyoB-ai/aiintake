# Legal Intake AI

Realtime video-intake voor advocatenkantoren. Een potentiële cliënt voert een gesprek
met een AI-intake-assistent; de advocaat begrijpt binnen 2–5 minuten in een dashboard of
de zaak interessant en urgent is.

**Het is geen AI-advocaat.** De assistent verzamelt, structureert en signaleert. Hij
geeft geen juridisch advies. Elke juridische beoordeling blijft bij de advocaat.

Rechtsgebied v1: arbeidsrecht. Talen: Nederlands en Engels.

---

## Waar u nu staat

**Fase 0 is afgerond.** De Definition of Done was dat de tenant-isolatietests groen
zijn, en dat zijn ze: 44/44 tegen een echt Supabase-project in de EU. Het schema, de
RLS-policies, het RPC-oppervlak en het agent-sessietoken zijn daarmee niet langer een
bewering maar een gemeten eigenschap.

Fase 1 — de realtime-lus, en het grootste technische risico van het project — is
begonnen op de `null`-avatarprovider. Zie [docs/ROADMAP.md](docs/ROADMAP.md) voor de
stand per taak en `docs/FASE-1-KEYS.md` voor wat er aan accounts nodig is om hem echt te
laten draaien.

---

## Architectuur in het kort

Twee planes met een gedeelde kern ([ADR-0001](docs/ADR-0001-twee-planes.md)):

```
apps/web     Next.js 15  — auth, tenants, dashboard, documenten, samenvattingen
apps/agent   Node worker — STT → engine → LLM → TTS → avatar, barge-in, WebRTC
                            langlevend proces in een container, EU-regio
```

De harde architectuurregel: `packages/intake-engine` is transport-agnostisch en mag
alleen `packages/domain` en `packages/prompts` importeren. Daardoor werkt exact dezelfde
intake-intelligentie in de videomodus én in de chat-fallback, en is hij testbaar zonder
één netwerkcall. Die regel is een build-fout, geen afspraak — `pnpm boundaries` faalt de
CI, en de regel is geverifieerd door hem opzettelijk te breken.

```
packages/
  domain          Zod-schema's, enums, feitcatalogus     ← onderste laag, importeert niets
  prompts         promptsjablonen + versiebeheer
  intake-engine   engine, planner, regels                ← geen I/O, geen vendor-SDK
  db-core         anon- en agent-client, RPC-wrappers    ← waar apps/agent aan hangt
  db              + RLS-omzeilende client, env, uitgifte ← waar apps/web aan hangt
  providers/*     LLM, STT, TTS, avatar, visual          ← Fase 1
  ui              design tokens, gedeelde presentatie
```

De splitsing tussen `db-core` en `db` is geen smaakkwestie: de agent-worker mag de
RLS-omzeilende sleutel fysiek niet kunnen bereiken
([ADR-0002](docs/ADR-0002-agent-zonder-service-role-key.md)).

---

## Opzetten

### Benodigd

- Node 22+
- pnpm 9 (`npm i -g pnpm`)
- Een Supabase-project **in een EU-regio** (eu-central-1 of eu-west-1). Dat is geen
  voorkeur: één trans-atlantische hop kost 80–120 ms in elke beurt, en een Nederlands
  kantoor kan een verwerker buiten de EU niet contracteren. De regio is bij
  projectcreatie te kiezen en daarna niet meer te wijzigen.
- Docker Desktop, alleen als u Supabase lokaal wilt draaien (`supabase start`). Zonder
  Docker werkt alles behalve de lokale database.

### Stappen

```bash
pnpm install
cp .env.example .env.local          # vul de Supabase-waarden in

# migraties naar uw project
pnpm dlx supabase link --project-ref <ref>
pnpm db:push

# demo-decor
psql "$DATABASE_URL" -f supabase/seed/seed.sql

pnpm dev
```

Maak daarna een gebruiker aan via Supabase Studio en koppel die aan het demo-kantoor;
het statement staat onderaan `supabase/seed/seed.sql`. Er is bewust geen zelfregistratie
— accounts worden door een kantoorbeheerder aangemaakt.

---

## Commando's

|                       |                                                                     |
| --------------------- | ------------------------------------------------------------------- |
| `pnpm dev`            | web + agent in watch-modus                                          |
| `pnpm test`           | alle tests behalve de isolatiesuite (91 groen, raakt geen database) |
| `pnpm typecheck`      | TypeScript over de hele monorepo                                    |
| `pnpm boundaries`     | architectuurgrenzen — faalt bij een overtreding                     |
| `pnpm test:isolation` | tenant-isolatie tegen een echte database                            |
| `pnpm db:check`       | volledige migratiereeks tegen een LEGE Postgres (geen Docker nodig) |
| `pnpm db:push`        | migraties naar het gekoppelde project                               |
| `pnpm db:types`       | genereer TypeScript-types uit het schema                            |

---

## Migratievolgorde

`pnpm db:check` draait bootstrap + alle migraties + de seed tegen een **lege** database
en faalt op de eerste fout, met bestand, regel en kolom.

Dit is geen luxe. Een functie met `language sql` krijgt zijn referenties al bij
`CREATE FUNCTION` geresolved, niet pas bij de eerste aanroep. Een helper die een tabel
noemt die later pas ontstaat, werkt daardoor prima op een database die al eens
gemigreerd is — en valt om op een verse. Dat merk je pas in de volgende nieuwe
omgeving, meestal die van de klant.

Lokaal start het script een embedded Postgres; **Docker is niet nodig**. In CI staat
`DATABASE_URL` en gebruikt het de service container (`postgres:15`, gelijk aan de major
version in `supabase/config.toml`).

`supabase/tests/bootstrap.sql` maakt vooraf precies aan wat Supabase zelf meelevert:
de rollen `anon`/`authenticated`/`service_role`, het `extensions`-schema, en minimale
`auth.users` en `storage`-tabellen. Alles wat onze eigen migraties horen te maken, staat
daar bewust niet in — anders zou de check een ontbrekende definitie kunnen maskeren.

De check controleert daarnaast twee dingen die je anders pas in productie ontdekt:

- **Geen tabel zonder row level security.**
- **Het API-oppervlak.** Elke functie in `public` die `anon` mag aanroepen, wordt
  vergeleken met een allowlist in het script. Dat is nodig omdat Supabase nieuwe
  functies in `public` automatisch EXECUTE geeft aan `anon` — vergeet je de `revoke`,
  dan staat je functie op internet. `bootstrap.sql` reproduceert die default expres, en
  de check is geverifieerd door een functie zonder `revoke` toe te voegen: hij faalde.

> Het script dropt schema's. Het weigert daarom te draaien tegen een `DATABASE_URL`
> waarvan de databasenaam geen `test` bevat, tenzij je `--force` meegeeft.

---

## Tests tegen een echte database

De tenant-isolatiesuite draait tegen een echt Supabase-project, niet tegen een mock.
Dat is geen keuze maar een noodzaak: RLS-policies zijn Postgres-gedrag, en een mock die
ze nabootst test alleen de mock.

Zet de drie waarden in `.env` op de repo-root:

```
SUPABASE_TEST_URL=https://<ref>.supabase.co
SUPABASE_TEST_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_TEST_SECRET_KEY=sb_secret_...
```

en draai:

```bash
pnpm test:isolation
```

Exporteren in de shell is niet nodig. `packages/db/vitest.config.ts` laadt `.env` via
een setupbestand vóórdat de testbestanden worden geïmporteerd — vitest doet dat niet
uit zichzelf, want Vite leest `.env` alleen voor `VITE_`-variabelen in
`import.meta.env` en laat `process.env` ongemoeid. Variabelen die al in de omgeving
staan winnen, zodat CI met secrets kan werken zonder dat een lokaal `.env` daar
doorheen fietst.

Ontbreekt er iets, dan slaat de suite zichzelf over met een melding die **noemt welke
variabele mist en welk env-bestand is gelezen** — zodat meteen duidelijk is of het aan
de waarde ligt of aan het inlezen. `INTAKE_ENV_DEBUG=1` laat dat ook zien bij een
geslaagde run (alleen namen en lengtes, nooit waarden).

De suite maakt twee kantoren, twee gebruikers en twee intakes aan, controleert 44
assertions en ruimt alles weer op.

> **Deze suite valt bewust buiten `pnpm test`.** Hij praat met een echte database en
> maakt daar data aan; dat hoort een expliciete keuze te zijn en geen bijwerking van
> een routineuze testrun. Gebruik een **apart testproject**, nooit een project met
> echte cliëntgegevens.

Wat er wordt bewezen:

- een gebruiker van kantoor A ziet niets van kantoor B — per tabel, ook gericht op id,
  ook via update, ook via de kindtabellen en de storage-paden;
- `anon` komt nergens bij, en krijgt via `public_org_by_slug` alleen naam, logo en taal
  — niet de providerconfiguratie of de acceptatiecriteria;
- het kortlevende agent-sessietoken kan alleen zijn eigen intake beschrijven, en wordt
  geweigerd zodra het verlopen, ingetrokken, van een ander kantoor, of gewoon verzonnen
  is — ook direct na afloop van de sessie, want die trekt het token in;
- uitgifte van sessietokens kan alleen serverside: niet door een anonieme bezoeker en
  niet door een ingelogde ORG_ADMIN;
- een verwijderd lidmaatschap geeft direct geen toegang meer;
- het auditlog is niet te wijzigen of te verwijderen, ook niet door een ORG_ADMIN.

---

## Niet-onderhandelbare uitgangspunten

Deze staan hier omdat ze in code zijn afgedwongen en niet alleen in een document.

1. **De demo is video.** Chat is fallback en testharnas, niet het product.
2. **De intake-intelligentie is vendor-onafhankelijk.** Afgedwongen door
   `pnpm boundaries`.
3. **Latency is een productvereiste.** Doel p50 < 1,2 s spraakeinde → eerste avatarframe
   met geluid. Zes stappen apart gemeten en weggeschreven naar `session_metrics`.
4. **Barge-in werkt, inclusief correcte transcript-truncatie.** `messages.content` bevat
   alleen wat de cliënt heeft gehoord; wat het model wilde zeggen staat apart en gaat
   nooit als geschiedenis naar het LLM.
5. **Geen emotieherkenning.** Interface bestaat, implementatie niet
   ([ADR-0005](docs/ADR-0005-geen-emotieherkenning.md)).
6. **Geen videoframes van de cliënt verlaten het apparaat**
   ([ADR-0004](docs/ADR-0004-clientcamera-blijft-lokaal.md)).
7. **AI-output is per definitie onbetrouwbaar.** Gesloten schema's, `unknown` blijft
   `unknown`, feiten zonder citaat in de bron worden geweigerd.
8. **Geen secrets in de browser, geen RLS-omzeilende sleutel in het agentproces**
   ([ADR-0002](docs/ADR-0002-agent-zonder-service-role-key.md)). De worker draait op de
   publishable key en legitimeert zich met een ondoorzichtig, intrekbaar sessietoken dat
   aan één intake is gebonden ([ADR-0007](docs/ADR-0007-agent-sessietoken.md)).

---

## Documentatie

|                                                                                 |                                                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [01-architectuur-en-providerkeuze.md](docs/01-architectuur-en-providerkeuze.md) | het architectuurdocument, inclusief providervergelijking en kostenmodel |
| [ROADMAP.md](docs/ROADMAP.md)                                                   | taken per fase, met status                                              |
| [RISICOS.md](docs/RISICOS.md)                                                   | vijf technische risico's met mitigatie                                  |
| [DPIA-input.md](docs/DPIA-input.md)                                             | verwerkingen, categorieën, subverwerkers                                |
| [ADR-0007](docs/ADR-0007-agent-sessietoken.md)                                  | waarom het agent-credential geen JWT is                                 |
| [ADR-0008](docs/ADR-0008-rpc-in-public-schema.md)                               | RPC's in `public`, `app` intern; wat dat doet met de EXECUTE-grants     |
| `ADR-*.md`                                                                      | architectuurbeslissingen, met de overwogen alternatieven                |
