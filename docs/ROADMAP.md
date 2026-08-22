# Roadmap

Fasering volgens §13 van de buildspec. De volgorde is bewust: de Definition of Done is
de demo, en het grootste technische risico zit in de realtime-lus. Dat risico wordt in
week 1 geretireerd, niet in fase 7.

Legenda: ✅ klaar · 🟡 deels · ⬜ open

---

## Fase 0 — fundament

**Klaar wanneer:** de tenant-isolatietests groen zijn.

|     | Taak                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------- |
| ✅  | Monorepo: pnpm workspaces + Turborepo, 8 packages, 2 apps                                                       |
| ✅  | `tsconfig.base.json` met `strict` + `noUncheckedIndexedAccess`                                                  |
| ✅  | Boundary-lintregel (dependency-cruiser), **geverifieerd door hem opzettelijk te breken**                        |
| ✅  | Databaseschema: 19 tabellen, 7 migraties                                                                        |
| ✅  | RLS-policies op elke tabel; `schema-parity` bewaakt dat er geen tabel zonder RLS bij komt                       |
| ✅  | RPC-oppervlak voor de publieke route en de agent (`app.create_public_intake`, `app.agent_*`)                    |
| ✅  | Kortlevend intake-token + pakketsplitsing db / db-core                                                          |
| ✅  | Auth: login, sessie-middleware, uitnodigingscallback, uitloggen                                                 |
| ✅  | Organisaties, rollen (4), rolrangorde in code én SQL                                                            |
| ✅  | Dashboardskelet met kaarten en intakelijst                                                                      |
| ✅  | Feitcatalogus arbeidsrecht: 17 categorieën, 45 feiten, conditioneel                                             |
| ✅  | Auditlog, append-only, met trigger op statuswijziging                                                           |
| ✅  | Rate limiting op de publieke intakeroute (kostenmaatregel)                                                      |
| ✅  | CI: boundaries, typecheck, tests, formattering                                                                  |
| ✅  | Seed: demo-kantoor + 5 intakes met feiten en risicovlaggen                                                      |
| 🟡  | **Tenant-isolatietests: geschreven (27 assertions), nog niet gedraaid — vereist een Supabase-project in de EU** |
| ⬜  | Supabase-project aanmaken (eu-central-1 / eu-west-1) en migraties pushen                                        |

## Fase 1 — "Hello face" (de risicospike)

**Klaar wanneer:** je vanuit Nederland tegen een sprekend gezicht praat, het onderbreekt,
en de HUD p50 < 1,5 s toont — gemeten per provider.

|     | Taak                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------- |
| 🟡  | `AvatarProvider` / `AvatarSession` interface (audio-first, met `interrupt() → spokenMs`)                                      |
| ⬜  | LiveKit room + tokenuitgifte vanuit `apps/web`                                                                                |
| ⬜  | Agent-worker: beurtcyclus STT → _echo_ → TTS → avatar                                                                         |
| ⬜  | Deepgram-provider (Flux, end-of-turn) + fake                                                                                  |
| ⬜  | Cartesia- en ElevenLabs-provider + fake; `cancel()` stil binnen 50 ms                                                         |
| ⬜  | Beyond Presence-provider                                                                                                      |
| ⬜  | Anam-provider                                                                                                                 |
| ⬜  | `null`-provider (statische placeholder, voor tests en kantoren zonder video)                                                  |
| ⬜  | Barge-in: client-VAD → lokaal dempen → STT start-of-turn → harde interrupt                                                    |
| ⬜  | **Transcript-truncatie op `spokenMs`** — de logica staat er (`truncateToSpoken`, getest); de aansluiting op de echte lus niet |
| ⬜  | Backchannel-onderdrukking in de lus (`isBackchannel` is getest)                                                               |
| ⬜  | Prewarm tijdens het toestemmingsscherm                                                                                        |
| ⬜  | Latency-HUD + wegschrijven naar `session_metrics`                                                                             |
| ⬜  | **Bakeoff-rapport: gemeten p50/p95 per provider vanuit NL, op Nederlandse audio**                                             |

> Deze fase kan pas echt draaien met accounts bij Beyond Presence en Anam. Alles wat
> zonder die accounts kan — interfaces, fakes, de `null`-provider, de HUD — kan wel
> vooruit.

## Fase 2 — intelligentie

**Klaar wanneer:** een volledige NL-intake van het VSO-scenario natuurlijk verloopt, met
maximaal één hoofdvraag per beurt en geen herhalingen.

- `QuestionPlanner` met deterministische scoring (urgentie, template, conditie,
  kantoorcriterium, reeds bekend, recent gevraagd, vermoeidheid)
- Arbeidsrecht-template v1 op de bestaande feitcatalogus
- Hot path: plat tekstmodel, zinsgewijs flushen, prompt caching
- Promptsjablonen met versiebeheer; `llm_calls` verwijst naar template + versie
- Hot path vervangt de echo uit Fase 1

## Fase 3 — cold path en dashboard

- `FactExtractor` met citaatverankering (`rejectUngroundedFacts` is getest)
- `UrgencyDetectionService`: rule engine als bron van waarheid, AI signaleert
- `CompletenessScorer`
- Intakedetailpagina: samenvatting, urgentie, feiten, tijdlijn, transcript, auditlog
- Statusacties: accepteren, afwijzen, meer informatie, doorverwijzen, gesprek plannen

## Fase 4 — documenten

- Upload met **magic-byte-validatie op de server** (de extensie is nooit het bewijs)
- Signed URLs met korte TTL
- Documentanalyse in een aparte call, inhoud tussen delimiters, gesloten schema
- Injectieverdediging + kwaadaardig PDF in de testsuite
- Deadline uit een document verhoogt urgentie pas na tweede, onafhankelijke regelcheck

## Fase 5 — samenvatting en review

- Samenvattingsgenerator met verwijzing per bewering
- Niet-herleidbare bewering → `NEEDS_HUMAN_CHECK`, niet tonen als klaar
- "Meer informatie"-verzoeken die met voorrang terugkomen in de volgende sessie

## Fase 6 — signalen, privacy, audit

- `VisualSignalProvider` in de browser (MediaPipe, 5–8 fps)
- Pacing-integratie; typegrens richting cold path
- Consent-UI met versienummers van beide teksten
- Retentie-instelling per kantoor + cleanup-service
- Conflictcheck vóór afronding

## Fase 7 — polish

- Demo-seed compleet: transcripten, samenvattingen, één document per intake
- Degradatiepaden: providerfout → audio-only → chat, nooit een blanco scherm
- Toegankelijkheid, iOS Safari (daar zitten de WebRTC- en autoplay-valkuilen)
- `docs/DPIA-input.md` afmaken
- README met opzetinstructies
