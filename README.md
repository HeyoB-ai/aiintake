# Legal Intake AI

Realtime video-intake voor advocatenkantoren. Een potentiële cliënt voert een gesprek
met een AI-intake-assistent; de advocaat begrijpt binnen 2–5 minuten in een dashboard of
de zaak interessant en urgent is.

**Het is geen AI-advocaat.** De assistent verzamelt, structureert en signaleert. Hij
geeft geen juridisch advies. Elke juridische beoordeling blijft bij de advocaat.

Rechtsgebied v1: arbeidsrecht. Talen: Nederlands en Engels.

---

## Waar u nu staat

Fase 0 (fundament) is gebouwd. De realtime-lus — Fase 1, de risicospike — nog niet; die
vereist accounts bij een avatarleverancier. Zie [docs/ROADMAP.md](docs/ROADMAP.md) voor
de precieze stand per taak.

Eén ding om te weten voordat u verder bouwt: **de tenant-isolatietests zijn geschreven
maar nog nooit gedraaid**, want er is nog geen Supabase-project. Dat is de Definition of
Done van Fase 0. Zie ["Tests tegen een echte database"](#tests-tegen-een-echte-database).

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

|                       |                                                                    |
| --------------------- | ------------------------------------------------------------------ |
| `pnpm dev`            | web + agent in watch-modus                                         |
| `pnpm test`           | alle tests (86 groen; 44 isolatietests slaan over zonder database) |
| `pnpm typecheck`      | TypeScript over de hele monorepo                                   |
| `pnpm boundaries`     | architectuurgrenzen — faalt bij een overtreding                    |
| `pnpm test:isolation` | tenant-isolatie tegen een echte database                           |
| `pnpm db:push`        | migraties naar het gekoppelde project                              |
| `pnpm db:types`       | genereer TypeScript-types uit het schema                           |

---

## Tests tegen een echte database

De tenant-isolatiesuite draait tegen een echt Supabase-project, niet tegen een mock.
Dat is geen keuze maar een noodzaak: RLS-policies zijn Postgres-gedrag, en een mock die
ze nabootst test alleen de mock.

Zonder credentials slaat de suite zichzelf over — met een expliciete melding, nooit
stilzwijgend. Een overgeslagen isolatietest die eruitziet als een geslaagde is precies
het soort geruststelling waar dit project niet tegen kan.

```bash
export SUPABASE_TEST_URL=...                 # gebruik een APART testproject
export SUPABASE_TEST_PUBLISHABLE_KEY=sb_publishable_...
export SUPABASE_TEST_SECRET_KEY=sb_secret_...
pnpm test:isolation
```

De suite maakt twee kantoren, twee gebruikers en twee intakes aan, controleert 44
assertions en ruimt alles weer op. Draai hem nooit tegen productie.

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
| `ADR-*.md`                                                                      | architectuurbeslissingen, met de overwogen alternatieven                |
