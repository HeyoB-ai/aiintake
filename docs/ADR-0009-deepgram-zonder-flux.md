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

**157 ms**, tegen een budget van 220 ms p50. Ruim binnen, en beter dan de vrees
rechtvaardigde. Het verlies van Flux kost dus niet wat het op papier leek te kosten.

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

Geen. Deepgram blijft de keuze: nova-3 doet Nederlands, de endpointing haalt het budget,
en de keyterm-parameter wordt geaccepteerd. Maar het belangrijkste argument uit het
architectuurdocument — Flux — geldt niet, en dat hoort vastgelegd te zijn voordat iemand
zich er later op beroept.

Als endpointing op echte spraak tegenvalt, is de volgende stap niet "een andere STT"
maar client-side VAD combineren met een lagere `endpointing`, en de misgeknipte beurten
opvangen in het herstelgedrag dat er al is.

## Twee metingen die dit ADR nog moeten afmaken

Beide staan als harnas klaar in `apps/agent/src/*.integration.test.ts` en wachten op
invoer.

**1. Endpointing op echte spraak met aarzeling.** De 157 ms hierboven is gemeten op
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
