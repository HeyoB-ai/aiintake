# ADR-0012 — Het latencybudget van 300/600 ms was een aanname, geen meting

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 2

## Wat er stond

Het architectuurdocument begroot de LLM-stap op **300 ms p50 / 600 ms p95** tot het eerste
token, als onderdeel van een totaal van 1200 ms p50. Die getallen zijn maandenlang
behandeld als de norm waaraan gemeten werd.

Ze zijn nooit gemeten. Het zijn plausibele getallen uit een architectuurdocument — net als
de aanname dat Deepgram Flux bestond, die evenmin verifieerd was en waarvan
[ADR-0009](ADR-0009-deepgram-zonder-flux.md) vastlegt dat de bron fout was en niet de
implementatie. Hier is het hetzelfde patroon: de bron is een schatting, niet een
waarneming, en dat stond nergens.

Dat het zolang meeging, komt doordat er niets tegenaan gemeten kón worden. De echo-agent
had geen model in de lus, dus de stap kostte 0,3 ms en de regel werd nooit op de proef
gesteld. Een budgetregel die niets kan afkeuren, voelt als een norm en is er geen.

## Wat we nu weten

Eerste meting met het model in de lus (`claude-haiku-4-5`, 8 beurten, vanaf Nederland):

```
p50   594 ms   p95   800 ms
```

Ontleed met `pnpm diag:ttft`:

| post                           | tijd    |
| ------------------------------ | ------- |
| netwerk + API-overhead         | ~205 ms |
| starten van de inferentie      | ~310 ms |
| onze promptlengte (519 tokens) | ~104 ms |

En met `pnpm diag:netwerk`, per regio vanaf dezelfde machine:

| endpoint                         | tcp   | tls   | warm verzoek |
| -------------------------------- | ----- | ----- | ------------ |
| api.anthropic.com (VS)           | 8 ms  | 22 ms | 123 ms       |
| Bedrock eu-central-1 (Frankfurt) | 19 ms | 49 ms | 16 ms        |
| Vertex europe-west4 (Eemshaven)  | 10 ms | 30 ms | 15 ms        |

De TCP-handshake naar Anthropic duurt 8 ms — dat is een edge dichtbij, niet de VS. Maar
een echt verzoek kost er 123 ms tegen 15 ms bij de EU-endpoints. De reis van de edge naar
de origin is dus de post, niet de handshake.

## Besluit

**De budgetregel wordt niet nu bijgesteld, en ook niet gehaald verklaard.** Hij wordt
herzien zodra het EU-endpoint gemeten is, op grond van wat gemeten is.

Wat de meting nu al waarschijnlijk maakt, en waarom dat vooraf gezegd moet worden: als de
netwerkpost van ~205 ms naar ~20 ms zakt maar het starten van de inferentie op ~310 ms
blijft, dan landt de TTFT rond de **400 ms** — met onze promptlengte erbij. Dat is beter
dan 594 ms en nog steeds boven 300 ms.

In dat geval is de conclusie niet dat de implementatie faalt, maar dat de regel te scherp
was opgeschreven. Welke van de twee het is, mag niet afhangen van welk getal beter uitkomt,
en daarom staat de verwachting hier vóór de meting in plaats van erna.

## Hoe de regel herzien wordt

Drie uitkomsten, met vooraf vastgelegde gevolgen:

1. **TTFT p50 onder 300 ms.** De regel klopte. Niets aanpassen.
2. **TTFT p50 tussen 300 en 450 ms, stabiel.** De regel was te scherp. Bijstellen naar het
   gemeten niveau plus een marge, en het totaalbudget van 1200 ms opnieuw optellen —
   inclusief de avatarvloer uit [risico 8](RISICOS.md).
3. **TTFT p50 boven 450 ms.** Dan is niet de regel het probleem maar de opstelling, en is
   de vraag welk model of welke serving-route wél haalbaar is.

Wat er in geen van de drie gevallen gebeurt: het budget aanpassen tot het gemeten getal
erin past en dat "gehaald" noemen.

## Gevolgen

- Het cijfer van 0,3 ms uit Fase 1 is uit RISICOS verwijderd; het was een leeg meetpunt.
- De TTFT-test heet niet langer "haalt het budget" maar "meet en rapporteert", omdat hij
  groen was bij 594 ms tegen een budget van 300 ms.
- Prompt caching is gemeten en afgevallen: bij onze promptlengte slaat de cache niet aan,
  en geforceerd op een prompt van 6504 tokens ging de TTFT omhoog in plaats van omlaag.
- De keuze voor Vertex `europe-west4` staat in
  `packages/providers/llm/src/vertex.ts`, met de meting erbij.
