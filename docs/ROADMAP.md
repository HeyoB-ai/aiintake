# Roadmap

Fasering volgens §13 van de buildspec. De volgorde is bewust: de Definition of Done is
de demo, en het grootste technische risico zit in de realtime-lus. Dat risico wordt in
week 1 geretireerd, niet in fase 7.

Legenda: ✅ klaar · 🟡 deels · ⬜ open

---

## Fase 0 — fundament ✅ AFGEROND

**Klaar wanneer:** de tenant-isolatietests groen zijn.

**Afgerond op 22 augustus 2026:** 44/44 isolatie-assertions groen tegen een echt
Supabase-project in de EU.

|     | Taak                                                                                         |
| --- | -------------------------------------------------------------------------------------------- |
| ✅  | Monorepo: pnpm workspaces + Turborepo, 8 packages, 2 apps                                    |
| ✅  | `tsconfig.base.json` met `strict` + `noUncheckedIndexedAccess`                               |
| ✅  | Boundary-lintregel (dependency-cruiser), **geverifieerd door hem opzettelijk te breken**     |
| ✅  | Databaseschema: 19 tabellen, 7 migraties                                                     |
| ✅  | RLS-policies op elke tabel; `schema-parity` bewaakt dat er geen tabel zonder RLS bij komt    |
| ✅  | RPC-oppervlak voor de publieke route en de agent (`app.create_public_intake`, `app.agent_*`) |
| ✅  | Ondoorzichtig, intrekbaar sessietoken (ADR-0007) + pakketsplitsing db / db-core              |
| ✅  | Auth: login, sessie-middleware, uitnodigingscallback, uitloggen                              |
| ✅  | Organisaties, rollen (4), rolrangorde in code én SQL                                         |
| ✅  | Dashboardskelet met kaarten en intakelijst                                                   |
| ✅  | Feitcatalogus arbeidsrecht: 17 categorieën, 45 feiten, conditioneel                          |
| ✅  | Auditlog, append-only, met trigger op statuswijziging                                        |
| ✅  | Rate limiting op de publieke intakeroute (kostenmaatregel)                                   |
| ✅  | CI: boundaries, typecheck, tests, migratievolgorde, formattering                             |
| ✅  | `pnpm db:check`: hele migratiereeks + seed tegen een lege Postgres, zonder Docker            |
| ✅  | Seed: demo-kantoor + 5 intakes met feiten en risicovlaggen                                   |
| ✅  | **Tenant-isolatietests: 44/44 groen tegen het echte project**                                |
| ✅  | Supabase-project in de EU, migraties toegepast                                               |
| ✅  | API-oppervlak afgebakend en in CI bewaakt (ADR-0008)                                         |

## Fase 1 — "Hello face" (de risicospike)

**Klaar wanneer:** je vanuit Nederland tegen een sprekend gezicht praat, het onderbreekt,
en de HUD p50 < 1,5 s toont — gemeten per provider.

**Stand:** alles wat zonder leverancier kan, draait en is getest. Wat resteert zijn
adapters en de meting zelf. Zie [FASE-1-KEYS.md](FASE-1-KEYS.md) voor de accounts.

|     | Taak                                                                              |
| --- | --------------------------------------------------------------------------------- |
| ✅  | `AvatarProvider` / `AvatarSession` (audio-first, `interrupt() → spokenMs`)        |
| ✅  | `SpeechToTextProvider` met model-native end-of-turn in het contract               |
| ✅  | `TextToSpeechProvider`, streaming en annuleerbaar                                 |
| ✅  | `LLMProvider` met gescheiden hot en cold path                                     |
| ✅  | `VisualSignalProvider`-contract (implementatie in Fase 6)                         |
| ✅  | Fakes voor STT, TTS en LLM — scriptbaar, zonder timers                            |
| ✅  | `null`-avatarprovider **met echte afspeelklok**, zodat truncatie hier al klopt    |
| ✅  | Beurtcyclus: end_of_turn → respons → zinsflush → TTS → avatar                     |
| ✅  | Zinsgewijs flushen (leesteken of 120 tekens), 8 tests                             |
| ✅  | Barge-in: annuleer generatie → TTS stil → avatar, in die volgorde                 |
| ✅  | **Transcript-truncatie op `spokenMs`**, aangesloten op de echte lus               |
| ✅  | Vals-positief-bescherming: backchannels en korte geluiden onderbreken niet        |
| ✅  | Herstelgedrag: de gehoorde prefix gaat mee naar de volgende beurt                 |
| ✅  | Latency-HUD: zes stappen, met budget en p50-poort                                 |
| ✅  | **Synthetisch barge-in-harnas in CI** — 11 tests, geen netwerk, geen keys         |
| ✅  | Nederlandse juridische keyterm-lijst (39 termen)                                  |
| ⬜  | LiveKit-room + tokenuitgifte vanuit `apps/web`                                    |
| ⬜  | Deepgram-adapter (Flux, end-of-turn, keyterms)                                    |
| ⬜  | Cartesia-adapter + ElevenLabs als tweede                                          |
| ⬜  | Beyond Presence-adapter                                                           |
| ⬜  | Anam-adapter                                                                      |
| ⬜  | Client-VAD gekoppeld aan `onClientSpeech`                                         |
| ⬜  | Prewarm tijdens het toestemmingsscherm                                            |
| ⬜  | Metriek wegschrijven naar `session_metrics` via de agent-RPC                      |
| ⬜  | **Bakeoff-rapport: gemeten p50/p95 per provider vanuit NL, op Nederlandse audio** |

> De resterende taken zijn adapters achter contracten die al vastliggen, plus de meting.
> De duurste onderdelen — de beurtcyclus, barge-in en de truncatie — zijn eruit, en zijn
> getest zonder dat er een account aan te pas kwam.

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
