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

**Stand:** STT, TTS en transport draaien tegen de echte API's, met gemeten cijfers.
Eerste meting (Cartesia → Deepgram, Nederlandse demozin): TTFA 108–132 ms, endpointing
155–167 ms, jargon foutloos. Wat resteert: de echo-agent op de echte keten, de twee
avataradapters en de bakeoff.

|     | Taak                                                                                        |
| --- | ------------------------------------------------------------------------------------------- |
| ✅  | `AvatarProvider` / `AvatarSession` (audio-first, `interrupt() → spokenMs`)                  |
| ✅  | `SpeechToTextProvider` met model-native end-of-turn in het contract                         |
| ✅  | `TextToSpeechProvider`, streaming en annuleerbaar                                           |
| ✅  | `LLMProvider` met gescheiden hot en cold path                                               |
| ✅  | `VisualSignalProvider`-contract (implementatie in Fase 6)                                   |
| ✅  | Fakes voor STT, TTS en LLM — scriptbaar, zonder timers                                      |
| ✅  | `null`-avatarprovider **met echte afspeelklok**, zodat truncatie hier al klopt              |
| ✅  | Beurtcyclus: end_of_turn → respons → zinsflush → TTS → avatar                               |
| ✅  | Zinsgewijs flushen (leesteken of 120 tekens), 8 tests                                       |
| ✅  | Barge-in: annuleer generatie → TTS stil → avatar, in die volgorde                           |
| ✅  | **Transcript-truncatie op `spokenMs`**, aangesloten op de echte lus                         |
| ✅  | Vals-positief-bescherming: backchannels en korte geluiden onderbreken niet                  |
| ✅  | Herstelgedrag: de gehoorde prefix gaat mee naar de volgende beurt                           |
| ✅  | Latency-HUD: zes stappen, met budget en p50-poort                                           |
| ✅  | **Synthetisch barge-in-harnas in CI** — 11 tests, geen netwerk, geen keys                   |
| ✅  | Nederlandse juridische keyterm-lijst (39 termen)                                            |
| ✅  | LiveKit: roombeheer + tokens per rol, geverifieerd tegen de live server                     |
| ✅  | Deepgram-adapter (nova-3, endpointing + UtteranceEnd, keyterms) — ADR-0009                  |
| ✅  | Cartesia-adapter (sonic-3, per-beurt context, annuleerbaar)                                 |
| ⬜  | ElevenLabs als tweede TTS                                                                   |
| ⬜  | Beyond Presence-adapter                                                                     |
| ⬜  | Anam-adapter                                                                                |
| ⬜  | Client-VAD gekoppeld aan `onClientSpeech`                                                   |
| ⬜  | Prewarm tijdens het toestemmingsscherm                                                      |
| ⬜  | Metriek wegschrijven naar `session_metrics` via de agent-RPC                                |
| ⬜  | **Bakeoff-rapport: p50/p95 per provider, gemeten vanaf een machine in NL — niet vanuit CI** |
| ⬜  | Endpointing meten op echte spraak met aarzeling (opname wordt aangeleverd)                  |
| ⬜  | Keyterm prompting meten mét en zonder lijst; werkt het niet, dan uit de spec                |

> De resterende taken zijn adapters achter contracten die al vastliggen, plus de meting.
> De duurste onderdelen — de beurtcyclus, barge-in en de truncatie — zijn eruit, en zijn
> getest zonder dat er een account aan te pas kwam.

## Fase 2 — intelligentie

**Klaar wanneer:** een volledige NL-intake van het VSO-scenario natuurlijk verloopt, met
maximaal één hoofdvraag per beurt en geen herhalingen.

- [x] `QuestionPlanner` met deterministische scoring (urgentie, template, conditie,
      kantoorcriterium, reeds bekend, vermoeidheid) — `planner.ts`, 16 tests
- [x] Arbeidsrecht-template v1 en de urgentieregels op de bestaande feitcatalogus —
      `employment-template.ts`
- [x] `IntakeConversationEngine`: hot path streamt platte tekst, cold path met gesloten
      schema en één herstelpoging — `engine.ts`, 11 tests, geen netwerkcall
- [x] `CompletenessScorer` — naar voren gehaald uit Fase 3, want de planner kan zonder
      volledigheidsscore niet beslissen wanneer hij moet afronden
- [x] Promptsjablonen met versiebeheer en een register dat dubbele sleutels weigert
- [ ] Prompt caching op het hot path
- [ ] `llm_calls` daadwerkelijk vullen vanuit de worker (de engine levert de sleutel en
      versie al via `onPrompt`)
- [ ] Hot path vervangt de echo uit Fase 1 in `apps/agent`

**Onderweg gevonden.** `IntakeTemplate.requiredFactKeys` dupliceerde precies wat de
feitcatalogus al als `required` markeerde: twee bronnen voor dezelfde waarheid, waarvan
er één niets deed. De catalogus bepaalt nu wat er standaard nodig is (per feit, per
voorwaarde), het template is de kantoorspecifieke laag erbovenop.

## Fase 3 — cold path en dashboard

> **Blokkeert het meeste hieronder: de worker schrijft niets weg.** Zeven van de negen
> agent-RPC's worden nergens aangeroepen (risico 15). De extractie draait, de scores worden
> berekend, en het resultaat verdwijnt. Een dashboardpagina bouwen op kolommen die nooit
> gevuld worden, levert een scherm op dat er af uitziet en leeg blijft. Dit hoort de eerste
> taak van deze fase te zijn, vóór de detailpagina wordt uitgebreid.

- `FactExtractor` met citaatverankering (`rejectUngroundedFacts` is getest)
- `UrgencyDetectionService`: rule engine als bron van waarheid, AI signaleert
- Tegenspraak zichtbaar maken: een feit dat verandert nadat het is vastgelegd, houdt zijn
  vorige waarde en toont dat op de detailpagina. Zonder dat is een gecorrigeerd feit niet
  van een bevestigd feit te onderscheiden — risico 16
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
- Consent-UI met versienummers van beide teksten — de teksten zelf staan sinds 26 augustus
  op `/privacy` en `/ai-disclosure`, als **concept**; ze moeten door het kantoor worden
  vastgesteld voordat de conceptmarkering eraf mag
- Contactgegevens achter een strengere RLS dan de rest van de rij. `client_name`,
  `client_email` en `client_phone` vallen nu onder `intakes_select_org`, dus iedereen met
  toegang tot het kantoor ziet ze — ook een `VIEWER`. Bewust uitgesteld tot er een tweede
  tenant is; met één kantoor verandert het niets aan wie wat kan zien
- Retentie-instelling per kantoor + cleanup-service
- Conflictcheck vóór afronding

## Fase 7 — polish

- Demo-seed compleet: transcripten, samenvattingen, één document per intake
- Degradatiepaden: providerfout → audio-only → chat, nooit een blanco scherm
- Toegankelijkheid, iOS Safari (daar zitten de WebRTC- en autoplay-valkuilen)
- `docs/DPIA-input.md` afmaken
- README met opzetinstructies
