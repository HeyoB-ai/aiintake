# ADR-0009 — Nederlands loopt op nova-3, niet op Flux

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 1

## Context

Het architectuurdocument koos Deepgram om één specifieke reden: Flux, met
**model-native end-of-turn** onder ~300 ms. De redenering daarachter is scherp en nog
steeds juist — een vaste stiltedrempel van 700 ms is 700 ms die je in élke beurt
betaalt, bij een totaalbudget van 820 ms p50.

Bij het bouwen van de adapter bleek Flux niet beschikbaar. Niet voor Nederlands, en
niet voor enige taal: in de modellenlijst van dit account (`GET /v1/models`, 437 STT-
modellen) komt de naam nergens voor. Nederlands wordt gedekt door `nova-3-general`
(`nl`, `nl-BE`, `nl-NL`).

**De aanname was fout, niet de uitvoering.** Flux stond als vaststaand gegeven in het
architectuurdocument en is daar nooit tegen de API geverifieerd. Er is dus niets
misgegaan bij het bouwen; er is iets misgegaan bij het aannemen. Dat onderscheid is de
moeite van het opschrijven waard, omdat het bepaalt waar de correctie hoort: in de
brondocumentatie en in de manier waarop we vendorclaims behandelen, niet in de adapter.

De praktische les: elke leverancierseigenschap waarop een architectuurkeuze rust, hoort
geverifieerd te worden vóórdat hij als argument telt. `pnpm keys:check` doet dat nu voor
bereikbaarheid; modelbeschikbaarheid en taaldekking horen daar op termijn bij.

## Besluit

Nederlands loopt op **nova-3**. Turn-taking gaat daarmee niet via het model maar via
endpointing, met twee knoppen:

| Parameter          | Waarde  | Wat het doet                                                 |
| ------------------ | ------- | ------------------------------------------------------------ |
| `endpointing`      | 300 ms  | stilte voordat een resultaat `speech_final` wordt            |
| `utterance_end_ms` | 1000 ms | gat tussen woordtijdstempels dat een `UtteranceEnd` oplevert |

`UtteranceEnd` is het vangnet: valt het laatste woord weg zonder `speech_final`, dan
sluit dat event de beurt alsnog af. `SpeechStarted` (via `vad_events=true`) is de vroege
barge-in-trigger.

## Wat de meting zegt

Dit is precies het risico waar het architectuurdocument voor waarschuwde, dus het is de
moeite waard om te weten hoe erg het is. Gemeten op de rondgang
Cartesia → Deepgram (`pnpm test:pipeline`, Nederlandse demozin):

```
Deepgram  endpointing 157 ms
transcript: "Ik kreeg gisteren van mijn werkgever een vaststellingsovereenkomst."
```

Dat leek ruim binnen het budget van 220 ms p50. Die conclusie is hieronder herzien: er
werd het verkeerde ding gemeten.

### Herzien na de meting over de volledige lus

De 157 ms hierboven was gemeten van _laatste audioblok_ tot `end_of_turn`. Dat is niet
hetzelfde als endpointing: tussen het laatste woord en het laatste audioblok zit nog
stilte. Over de volledige lus wordt nu gemeten vanaf het einde van het laatste woord,
afgeleid uit Deepgram's woordtijdstempels. Vier runs:

|     | endpointing | totaal (null-avatar) |
| --- | ----------- | -------------------- |
| 1   | 296 ms      | 407 ms               |
| 2   | 322 ms      | 454 ms               |
| 3   | 253 ms      | 359 ms               |
| 4   | 335 ms      | 452 ms               |

**p50 ≈ 309 ms**, tegen een budget van 220 ms p50 en 350 ms p95. Dat volgt vrijwel exact
de `endpointing=300`-instelling, wat klopt: de drempel ís de latency.

Daarmee valt het gunstiger beeld van de eerste meting weg. Endpointing zit boven het
p50-budget en tegen het p95-budget aan, en dat is op schone synthetische spraak.

**Eén van de vier runs kapte de uitspraak af**: "Ik kreeg gisteren een
vaststellingsovereenkomst" — zonder "van mijn werkgever". `speech_final` viel middenin.
Dat is precies het faalgedrag dat bij een te agressieve drempel hoort, en het is nu al
zichtbaar op audio zonder aarzeling. Op echte spraak wordt dat vaker, niet minder.

Twee kanttekeningen die eerlijk moeten meegaan:

- Dit is één meting op **synthetische spraak**. Cartesia produceert schone audio met een
  duidelijk zinseinde; een echte cliënt die aarzelt, "eh" zegt of doorpraat, is een
  ander geval. Het getal is een ondergrens, geen p50.
- Endpointing op 300 ms is agressief. Knipt het te vaak midden in een aarzeling, dan is
  de knop omhoog draaien — met directe kosten in het latencybudget. Die afweging komt
  terug zodra er op echte spraak wordt gemeten.

## Keyterm prompting

De Nederlandse juridische termenlijst (`packages/providers/stt/src/keyterms.ts`) gaat
als `keyterm`-parameter mee. In de rondgang kwam
"vaststellingsovereenkomst" foutloos terug — precies het woord waar een algemeen
Nederlands model op stukloopt.

Ook hier past terughoudendheid: één correcte transcriptie bewijst niet dat keyterm
prompting voor Nederlands actief is. Het kan ook zijn dat nova-3 het woord sowieso kent.
Om dat te scheiden is een meting nodig met en zonder de lijst, op meerdere termen.

## Gevolg voor de providerkeuze

Voorlopig geen: nova-3 doet Nederlands en de keyterm-parameter wordt geaccepteerd. Maar
het belangrijkste argument uit het architectuurdocument — Flux — geldt niet, en de
endpointing haalt het p50-budget níét (309 ms tegen 220 ms).

Dat is nog geen reden om van leverancier te wisselen, want het alternatief zou hetzelfde
probleem hebben: zonder model-native turn detection ís de stiltedrempel de latency. Wel
een reden om het als open punt te behandelen in plaats van als opgelost.

Als endpointing op echte spraak tegenvalt, is de volgende stap niet "een andere STT"
maar client-side VAD combineren met een lagere `endpointing`, en de misgeknipte beurten
opvangen in het herstelgedrag dat er al is.

## Twee metingen die dit ADR nog moeten afmaken

Beide staan als harnas klaar in `apps/agent/src/*.integration.test.ts` en wachten op
invoer.

**1. Endpointing op echte spraak met aarzeling.** De 309 ms p50 hierboven is gemeten op
synthetische audio met een schoon zinseinde. Wat de drempel werkelijk waard is, blijkt
pas bij "eh", een pauze midden in een zin, en een zin die wegsterft — precies de
gevallen waar een vaste stiltedrempel omvalt. Zodra de opname er is, wordt hier de
gemeten p50/p95 opgenomen, met per fragment of de beurt op de juiste plek werd geknipt.

Mogelijke uitkomst die we serieus moeten nemen: dat `endpointing=300` te vroeg knipt en
omhoog moet. Dat kost direct latencybudget, en dan is de afweging expliciet in plaats
van impliciet.

**2. Keyterm prompting, mét en zonder lijst.** Nu is alleen vastgesteld dát
"vaststellingsovereenkomst" goed terugkomt, niet dát de lijst daaraan bijdraagt — nova-3
kan het woord ook zonder hulp kennen. De meting draait dezelfde fragmenten twee keer,
één keer met `keyterm` en één keer zonder, over meerdere termen uit de lijst.

Als het verschil nul is, hoort de keyterm-lijst uit de specificatie: dan is het dode
configuratie die de indruk wekt dat er iets geregeld is. Dat is een reëel mogelijke
uitkomst, want keyterm prompting is bij Deepgram gedocumenteerd voor nova-3 Engels.
