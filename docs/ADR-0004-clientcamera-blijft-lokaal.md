# ADR-0004 — De cliëntcamera wordt standaard niet gepubliceerd

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0 (afgedwongen in Fase 6)

## Context

Camera-awareness is een productwens: weten of iemand er nog zit, of iemand knikt, of
iemand wegkijkt. De verleiding is om de cliëntvideo naar de room te publiceren en die
daar te analyseren. Dat is technisch het makkelijkst en juridisch het duurst.

## Besluit

Twee grenzen, allebei hard.

**1. Alle visuele analyse draait in de browser.** MediaPipe FaceLandmarker via WASM,
5–8 fps, op een geschaalde frame. Over de datachannel gaan uitsluitend booleans
(`VisualSignals` in `packages/domain/src/schemas/visual-signals.ts`). Er verlaat geen
enkel videoframe het apparaat voor analyse.

**2. De self-view is lokaal; de camera wordt niet naar de room gepubliceerd.**
`getUserMedia` → `<video>`, zonder track-publicatie. Er staat dan letterlijk geen
clientvideo op enige server, en daarmee vervalt een hele categorie AVG-risico.
Publiceren is een aparte organisatie-instelling (`organizations.publish_client_video`)
die standaard uit staat, voor kantoren die de opname wél willen.

## Gebruiksgrenzen

Visuele signalen voeden **uitsluitend** het dialoogbeleid: timing, pacing, wel of niet
onderbreken. Zij komen nooit in `case_facts`, nooit in `risk_flags`, nooit in de
samenvatting en nooit in een cold-path prompt.

Dat wordt als type afgedwongen, niet als afspraak: `VisualSignals` is geen toegestane
input voor `FactExtractor` of `SummaryGenerator`.

Concreet:

- Een knik onderdrukt hooguit een overbodige bevestigingsvraag. Een knik is **nooit**
  bewijs van instemming, akkoord of erkenning. Nergens komt "cliënt bevestigde X" te
  staan op grond van een hoofdbeweging.
- Wegkijken leidt tot niets: geen conclusie, geen vlag, geen aantekening.
- Signalen zijn efemeer. Niet persisteren, of hooguit geaggregeerd voor debugging met
  een bewaartermijn in uren (`retentionPolicy.visualSignalRetentionHours`, default 0).

## Wat is geschrapt

`smileDetected` is uit de MVP-set gehaald. Het is als enige geen interactioneel maar een
affectief signaal — precies de grens die we hier willen trekken — en het levert
conversationeel vrijwel niets op.
