# Technische risico's

Op volgorde van hoe hard ze het project kunnen raken. Voor privacyrisico's als aparte
categorie: zie [DPIA-input.md](DPIA-input.md).

---

## 1. De latencybegroting haalt het niet, en dat merk je pas in week 3

**Waarom dit bovenaan staat.** De hele propositie is dat het gesprek _natuurlijk_ aanvoelt.
Bij p50 boven ~1,5 s voelt elke beurt als wachten en is het product een chatbot met een
gezicht erop. De industriële mediaan voor cascaded voice agents ligt rond 1,4–1,7 s, dus
het doel van 1,2 s is ambitieus, en de vendorclaims meten niet hetzelfde ding: "<100 ms"
bij Beyond Presence is streaming inference, "180 ms" bij Anam is agent-responstijd, en
geen van beide is de tijd tussen het laatste woord van de cliënt en de eerste
mondbeweging.

**Mitigatie.** Fase 1 is expliciet de risicospike en staat vóór alle intelligentie. De
HUD meet zes stappen apart, zodat je bij overschrijding weet wélke stap het is en niet
gaat gokken. De grootste hefbomen zitten in het ontwerp: geen JSON op het hot path,
zinsgewijs flushen naar TTS, model-native end-of-turn, prewarm tijdens het
toestemmingsscherm, en colocatie van worker, STT, TTS, LLM en avatar in dezelfde
EU-regio.

**Signaal dat het misgaat.** `session_metrics` p50 boven 1,5 s na tuning, of een enkele
stap die structureel boven zijn p95-budget zit.

### Waarom `speech_final` uitblijft: de ruisvloer van de microfoon

Gemeten met `pnpm diag:speechfinal` — dezelfde zin, dezelfde stilte erachter, alleen een
andere ruisvloer. Stabiel over twee runs:

| ruisvloer                     | sluit via       | na einde spraak |
| ----------------------------- | --------------- | --------------- |
| digitale stilte               | `speech_final`  | ~601 ms         |
| rustige kamer (−50 dBFS)      | `speech_final`  | ~2000 ms        |
| ventilator of straat (−36 dB) | `utterance_end` | ~2350 ms        |
| rumoerig (−24 dBFS)           | `utterance_end` | ~2400 ms        |

**De ruisvloer bepaalt zowel het mechanisme als de latency.** `endpointing` werkt op VAD
over de audio: Deepgram moet stilte _horen_. `UtteranceEnd` werkt op gaten tussen
woordtijdstempels en heeft alleen de afwezigheid van woorden nodig. Een microfoon in een
rustige kamer levert geen digitale stilte, dus het normale pad wordt traag of blijft uit.

Dit is dus geen instelling die verkeerd staat. `endpointing=300` is correct; er is alleen
geen stilte om op te reageren.

**Wat eraan gedaan is.** De praatpagina heeft nu een ruispoort: onder ~−46 dBFS gaan er
echte nullen naar de STT. Dat maakt van het "rustige kamer"-geval het geval "digitale
stilte", en dat scheelt volgens de tabel ruim een seconde.

De drempel staat bewust laag en de poort sluit pas na 120 ms aaneengesloten stilte. Zachte
spraak wegpoorten zou dataverlies zijn, en dat is precies wat risico 2 verbiedt — liever
ruis doorlaten dan een woord verliezen. Of die afweging goed valt, hoort in een echte
sessie beoordeeld te worden en niet op een tabel.

**Wat dit niet oplost.** In een rumoerige omgeving blijft het vangnet het pad, en dan is
~2,4 s tot het sluiten van de beurt de realiteit. Dat is een grens van deze
STT-configuratie, geen tuningkwestie, en het hoort mee te wegen in de vraag of het
totaalbudget van 1,2 s haalbaar is.

**Een kanttekening bij de vergelijking.** De ~601 ms hierboven is gemeten vanaf het einde
van de audio; de HUD meet vanaf het laatste woordtijdstempel. Die twee zijn niet
inwisselbaar, en de getallen uit deze tabel horen dus niet naast de HUD-cijfers gelegd te
worden.

### Een endpointing-uitschieter die er geen was

Live viel één beurt op met **eot 1283 ms** tegen een normale 250–310. Dat leek het
aarzelgedrag waarop we wilden meten, maar het is een ander codepad: sluit de beurt via het
vangnet in plaats van via `speech_final`, dan wacht Deepgram eerst `utterance_end_ms`
(1000 ms) aan stilte af. Zo'n beurt _kan_ niet onder de duizend milliseconde uitkomen.

`end_of_turn` draagt daarom nu `endedBy`, en de HUD schrijft er "eot via vangnet
(UtteranceEnd)" bij. Zonder dat label is een trage beurt niet te onderscheiden van een
beurt die nooit sneller had kunnen zijn — en zou tuning op endpointing zich richten op een
getal dat niets over endpointing zegt.

Wat dit betekent voor de p50: beurten via het vangnet horen apart geteld te worden. Zitten
er veel in, dan is de vraag niet "waarom is endpointing traag" maar "waarom komt het
laatste woord niet als `speech_final` door".

### Eerste echte meting van het hot path — 22 augustus 2026

Tot nu toe stond hier 0,3 ms voor de LLM-stap. Dat was geen prestatie maar een leeg
meetpunt: de echo-agent had geen model, dus er viel niets te wachten. Met het model in de
lus (`claude-haiku-4-5`, 8 beurten van een VSO-gesprek, vanaf Nederland):

```
ruw   611, 603, 537, 617, 898, 585, 536, 524 ms
p50   594 ms   (budget 300)
p95   800 ms   (budget 600)
```

**De stap zit er twee keer overheen op p50 en een derde op p95.** Er is geen ruimte; er is
een tekort van ongeveer 290 ms per beurt.

Wat de cijfers verder zeggen. De vloer ligt op 524 ms en zeven van de acht waarden liggen
tussen 524 en 617 — dat is een strakke verdeling, geen ruis. De 898 is de enige
uitschieter en staat alleen; er zit geen oplopende trend in, dus het is niet de groeiende
promptlengte maar een incident.

Dat een strakke verdeling zo hoog ligt, is het echte signaal: dit is geen variabiliteit die
je wegtuned, dit is waar deze opstelling structureel uitkomt.

### Waar die 594 ms vandaan komt — en het is grotendeels niet het model

`pnpm diag:ttft` knipt de beurt in fasen. De uitkomst verlegt de conclusie hierboven.

```
netwerk + API zonder inferentie (GET /v1/models)   mediaan  205 ms
minimaal systeemprompt (19 tokens)                 mediaan  515 ms
ons systeemprompt (519 tokens)                     mediaan  619 ms
```

Opgeteld:

| post                                   | tijd    |
| -------------------------------------- | ------- |
| netwerk + API-overhead, Nederland → VS | ~205 ms |
| starten van de inferentie              | ~310 ms |
| onze promptlengte (500 tokens extra)   | ~104 ms |

**Een derde van de tijd is een round trip die niets met het model te maken heeft.** Wat
wij aan de prompt kunnen doen is de kleinste post van de drie.

Drie dingen die hiermee zijn uitgesloten als oorzaak:

- **Connectiehergebruik werkt.** De eerste aanroep is telkens de traagste (758 ms), daarna
  vlakt het af rond 560–620 ms. Zou er per beurt een nieuwe TLS-handshake zijn, dan bleef
  elke aanroep op dat eerste niveau staan.
- **Onze SSE-verwerking kost niets.** `headers`, `eerste byte` en `eerste tekst` liggen
  binnen twee milliseconde van elkaar. We registreren het eerste token dus op het moment
  dat het binnenkomt, niet na een volledige chunk.
- **De promptlengte is niet de boosdoener.** 500 tokens extra kosten ~104 ms.

### Prompt caching helpt hier niet, en dat is gemeten

De cache sloeg nooit aan: `cache_read` en `cache_creation` bleven op nul. Anthropic
hanteert een minimumlengte voor een cachebaar blok en ons systeemprompt van ~519 tokens
haalt die niet.

Om te controleren of het mechanisme überhaupt werkt is het prompt kunstmatig opgeblazen
tot 6504 tokens. Toen sloeg het wél aan — eerst `0 / 6504` geschreven, daarna `6504 / 0`
gelezen — maar de TTFT ging er niet van omlaag: mediaan 783 ms tegen 619 ms zonder cache.

**Caching bespaart het herverwerken van tokens, en die post was hier al de kleinste.** Het
in de provider bouwen zou dode configuratie zijn: hij kan bij onze promptlengte niet
aanslaan, en zou bij een langer prompt de latency niet redden. Niet gebouwd, en dat is de
uitkomst van de meting en niet een overslagen taak.

### Wat wél de hefboom is

Het EU-regio-endpoint. De architectuur eist dat al om een andere reden — de
subverwerkerketen moet in de EU liggen, zie §10 van het architectuurdocument, dat Bedrock
`eu-central-1` of Vertex `europe-west4` noemt in plaats van een globale endpoint. Die ene
wijziging bedient nu twee doelen: hij is nodig voor de AVG-lijn en hij raakt de grootste
post die wij kunnen beïnvloeden.

De netwerkpost is inmiddels wél per regio gemeten (`pnpm diag:netwerk`, vanaf Nederland):

| endpoint                         | tcp   | tls   | warm verzoek |
| -------------------------------- | ----- | ----- | ------------ |
| api.anthropic.com (VS)           | 8 ms  | 22 ms | 123 ms       |
| Bedrock eu-central-1 (Frankfurt) | 19 ms | 49 ms | 16 ms        |
| Vertex europe-west4 (Eemshaven)  | 10 ms | 30 ms | 15 ms        |

De handshake naar Anthropic duurt 8 ms — dat is een edge dichtbij, niet de VS. Maar een
echt verzoek kost er 123 ms tegen 15 ms. De reis van de edge naar de origin is dus de post.

**Gekozen: Vertex `europe-west4`.** Op het warme verzoek ontloopt het Frankfurt niets, op
de handshake is Eemshaven bijna twee keer zo dichtbij, en het staat in Nederland — wat voor
een Nederlands kantoor een ander antwoord is dan Duitsland. De provider staat in
`packages/providers/llm/src/vertex.ts`.

**De koude ronde hoort in dezelfde afweging.** `observe()` duurt ~5,5 s (was 8,5 s voordat
de extractie tot relevante categorieën werd beperkt), terwijl een cliënt binnen twee
seconden antwoordt. De planner werkt daardoor structureel met feiten van twee of drie
beurten terug, en vraagt dingen die allang verteld zijn. Dat is nu afgedekt met een
promptinstructie — "sla een onderwerp over dat al beantwoord is" — en dat is een pleister,
geen fundament: het gedrag hangt af van of het model die instructie opvolgt.

De echte oplossing zit in dezelfde richting als het EU-endpoint, en het is dezelfde vraag:
hoeveel van die 5,5 s is reistijd, hoeveel is inferentie, en wat blijft er over als het
dichterbij draait. Zolang dat niet gemeten is, is "de planner loopt achter" een
architectuurpunt en geen bug.

**Wat het EU-endpoint waarschijnlijk niet oplost.** Zakt de netwerkpost van ~205 ms naar
~20 ms terwijl het starten van de inferentie op ~310 ms blijft, dan landt de TTFT rond
400 ms. Beter dan 594, en nog steeds boven de 300 ms uit de begroting. Dat die begroting zelf een aanname was
en geen meting, staat in [ADR-0012](ADR-0012-latencybudget-is-een-aanname.md) — met vooraf
vastgelegd wat er bij welke uitkomst met de regel gebeurt.

**Nog te doen.** De eindmeting vraagt GCP-credentials (`VERTEX_*` in `.env.example`) en
verificatie dat het Haiku-model in `europe-west4` beschikbaar is. Beide ontbreken nu.

**Waarom dit samen met risico 8 gelezen moet worden.** Anam kost in passthrough ~807 ms
voordat er geluid komt. Die twee stappen tellen niet volledig bij elkaar op — de TTS
levert audio terwijl het model nog genereert — maar 594 ms LLM plus een avatarvloer van
~800 ms past niet in een totaalbudget van 1200 ms p50. Op dit moment is het totaalbudget
niet krap maar onhaalbaar, en de twee grootste posten zijn allebei gemeten en allebei te
groot.

---

## 2. De STT knipt een uitspraak doormidden en niemand merkt het

**Dit is geen latencyprobleem.** Het staat los van het budget en hoort niet als
bijvangst van endpointing behandeld te worden, want de schade is van een andere soort:
bij latency wordt het gesprek traag, hier wordt de intake **stil onjuist**.

**Wat er gebeurt.** Deepgram besluit op basis van een stiltedrempel dat de cliënt is
uitgesproken (`speech_final`) terwijl die nog midden in een zin zit. Wij sluiten de
beurt af met wat er tot dan toe binnenkwam. De rest van de zin komt daarna alsnog
binnen, maar de engine heeft de beurt al verwerkt.

Waargenomen op **1 van de 4 runs**, op schone synthetische spraak zonder aarzeling:

```
gezegd:      "Ik kreeg gisteren een vaststellingsovereenkomst van mijn werkgever."
verwerkt:    "Ik kreeg gisteren een vaststellingsovereenkomst"
```

**Waarom dit erger is dan het lijkt.** De engine denkt te hebben gehoord wat er nooit
binnenkwam. Er is geen foutmelding, geen lege waarde, geen twijfelsignaal — alleen een
zin die grammaticaal klopt en inhoudelijk incompleet is. Dat werkt door:

- de assistent beantwoordt een half gehoorde vraag, en klinkt daarbij volkomen zeker;
- de fact extraction ziet een uitspraak zonder de bepaling die hem betekenis gaf
  ("van mijn werkgever", "sinds maart", "nog niet");
- de samenvatting neemt dat over als vastgesteld feit, met bronverwijzing en al — want
  het citaat _staat_ letterlijk in het transcript;
- de advocaat leest een samenvatting die klopt met de brondata en toch niet met wat de
  cliënt zei.

De ingebouwde controles vangen dit niet. `rejectUngroundedFacts` controleert of een
feit in het transcript staat, niet of het transcript compleet is. Een afgekapte zin is
een perfect verankerde bron.

**Wat het gevaarlijkst maakt:** dit degradeert niet zichtbaar. Een systeem dat vastloopt
merk je; een systeem dat elke twintigste zin halveert, merk je pas als een advocaat op
een verkeerd feit afgaat.

**Mitigatie, gebouwd.** De STT-laag detecteert nu een te vroege knip: komen er na een
`speech_final` woorden binnen die tijdgewijs aansluiten op de vorige, dan hoorden ze bij
dezelfde uitspraak. Deepgram's `UtteranceEnd` levert daarnaast een eigen `last_word_end`;
ligt die ná het punt waarop wij afkapten, dan is dat een tweede, onafhankelijk signaal.
De lus behandelt zo'n geval als wat het is — de cliënt was nog aan het woord — en breekt
het antwoord af in plaats van een halve vraag te beantwoorden.

**Wat de eerste live-sessie opleverde, 22 augustus 2026.** De detectie meldde een
afkapping met een gat van **7300 ms**: twee uitspraken die zeven seconden uit elkaar lagen
werden aan elkaar geplakt. Dat was geen te ruime drempel maar een berekening zonder
bovengrens — de woordgat-detector begrensde netjes op 600 ms, de UtteranceEnd-detector had
géén grens en vuurde bij elk verschil.

Dat is erger dan niets doen. De detectie bestaat om stil dataverlies te repareren, en in
deze vorm veroorzaakte hij het: de eerste uitspraak kreeg tekst toegevoegd die er niet bij
hoorde, en de tweede verdween.

Gerepareerd met een **harde bovengrens van `utterance_end_ms`**, en niet met een gewogen
afweging. Een gat groter dan die waarde kán per definitie geen afkapping zijn: bij precies
dat gat besluit Deepgram zélf dat de uitspraak voorbij is. De controle staat op één plek
— in `reportContinuation` — zodat hij voor beide detectoren geldt en voor elke toekomstige.

De melding zegt nu ook wélke detector hem ving (`word_gap` of `utterance_end`). Er zijn
twee onafhankelijke detectoren die op verschillende manieren falen; weet je alleen dát er
is afgekapt, dan kun je bij een verkeerde melding niet zien welke van de twee je moet
bijstellen.

**Derde ronde, en toen de vorm.** Daarna meldde de detector een afkapping met een gat van
**0 ms**. Dat was geen nieuwe fout maar dezelfde: het interval stond op drie plaatsen met
drie verschillende regels — `word_gap` liet 0 ms toe, `utterance_end` eiste 50 ms, en de
bovengrens verschilde (600 tegen 1000 ms). Elke ronde repareerde er één.

Nu is er één begrip: `continuationInterval(utteranceEndMs)` levert het geldige interval,
`isPlausibleContinuationGap()` is het enige predicaat, en beide detectoren leveren alleen
kandidaten. De ondergrens is 50 ms — een afkapping veronderstelt een stilte om in te
knippen, en nul betekent dat twee tijdstempels hetzelfde moment beschrijven. De bovengrens
is `min(600, utterance_end_ms)`, zodat de tuning nooit boven de definitionele grens uitkomt
en meezakt als `utterance_end_ms` wordt verlaagd.

De tests gaan over de vórm en niet over losse grenzen: het geaccepteerde bereik moet één
aaneengesloten interval zijn, onder `utterance_end_ms` blijven bij elke configuratie, en
béide detectoren moeten hetzelfde oordeel geven over hetzelfde gat. Die laatste test had
ronde twee én ronde drie gevangen. Hij legde meteen een vierde randgeval bloot dat niemand
had gemeld: precies op de ondergrens besliste de drijvende-kommarepresentatie in plaats van
de regel, omdat `2,05 − 2` geen 50 ms oplevert maar 49,99999999999982. Er wordt nu
afgerond vóór de vergelijking.

Dertien regressietests in `packages/providers/stt/src/deepgram.test.ts`.

**Mitigatie, nog te doen.**

- Het signaal persisteren, zodat "hoe vaak knippen we verkeerd" een meetbare waarde
  wordt en geen indruk. Vraagt een kolom op `messages`; staat in de roadmap.
- Meten op echte spraak met aarzeling. Op synthetische audio is het 1 op 4; bij "eh" en
  wegstervende zinnen wordt dat vaker, niet minder.
- De afweging maken die daarna volgt: `endpointing` omhoog kost latencybudget maar
  verlaagt het dataverlies. Dat is een productbeslissing, geen instelling — en met deze
  detectie erbij is hij voor het eerst met cijfers te nemen in plaats van op gevoel.

---

## 3. Barge-in werkt "wel", maar het transcript klopt niet

**Waarom dit gevaarlijk is.** Dit is de meest gemene realtime-bug en hij is onzichtbaar in
unit tests: als je opslaat wat het model _wilde_ zeggen in plaats van wat de cliënt
_hoorde_, denkt het model dat het de vraag over de VSO-datum al gesteld heeft terwijl de
cliënt die nooit gehoord heeft. Het gesprek bouwt dan verder op gedeelde context die
niet bestaat. Het gesprek loopt door, alles lijkt te werken, en de intake wordt stil
onbruikbaar.

**Mitigatie.** `messages.content` bevat per definitie alleen het gehoorde deel;
`intended_content` staat in een aparte kolom die nooit als conversatiegeschiedenis
gebruikt wordt. `truncateToSpoken()` rekent de prefix uit `spokenMs` (uit
`AvatarSession.interrupt()`), met woordtijdstempels als de provider die levert en anders
een lineaire schatting — liever te veel afkappen dan te weinig, want een vraag opnieuw
stellen is onschuldig en een niet-gestelde vraag als gesteld beschouwen niet. De logica
is getest; de aansluiting op de echte lus volgt in Fase 1 en krijgt daar de expliciete
truncatietest uit §11.

---

## 4. ~~De tenantgrens is geschreven maar niet bewezen~~ — GESLOTEN, 22 augustus 2026

**Uitkomst.** 44/44 isolatie-assertions groen tegen een echt Supabase-project in de EU.
De tenantgrens is geen bewering meer.

Wat daarmee is aangetoond en niet langer op vertrouwen berust:

- een gebruiker van kantoor A ziet niets van kantoor B — per tabel, gericht op id, via
  update, via de kindtabellen en via de storage-paden;
- het sessietoken van de agent krijgt 42501 op een andere intake, is geweigerd zodra het
  verlopen of ingetrokken is, en wordt bij sessie-einde direct ingetrokken;
- uitgifte van sessietokens kan niet door anon en niet door een ingelogde ORG_ADMIN;
- het auditlog is niet te wijzigen, ook niet door een beheerder.

Het concrete faalscenario uit [ADR-0007](ADR-0007-agent-sessietoken.md) — de tokenhash
wordt in TypeScript én in plpgsql berekend, en bij afwijking valideert geen enkele
sessie — **heeft zich niet voorgedaan**. De twee implementaties komen overeen.

**Wat er van dit risico overblijft.** Een regressie in RLS of in het rechtenblok merk je
alleen als de suite blijft draaien. Twee dingen houden dat overeind: `pnpm db:check`
bewaakt in CI dat er geen tabel zonder RLS bij komt en dat het API-oppervlak niet
stilletjes groeit, en de isolatiesuite zelf hoort in CI te draaien met secrets. Dat
laatste is nog niet ingeregeld — zie de openstaande opmerking onderaan.

**Openstaand.** `pnpm test:isolation` eindigt met exit code 0 wanneer alle tests worden
overgeslagen. In CI zonder secrets is die job dus groen terwijl er niets draait. Dat is
precies de stille geruststelling die dit document elders afwijst. Op te lossen met een
strict-modus (`REQUIRE_DB_TESTS=1` laat de suite falen in plaats van skippen), aan te
zetten in de CI-job.

---

## 5. Vendorafhankelijkheid, in het bijzonder de avatarleverancier

**Twee kanten.** Commercieel: de avatar is 60–80% van de variabele kosten, dus een
prijsverandering raakt de marge direct. Juridisch: Beyond Presence documenteert de eigen
marketingstack tot in detail maar zegt niets over de sessiedata — geen opslaglocatie,
geen bewaartermijn, geen trainingsverklaring, geen biometrieclausule. Voor een bedrijf
dat "fully GDPR compliant" als hoofddifferentiator voert, is dat de opvallendste
omissie, en het is precies wat een compliance-officer van een advocatenkantoor als
eerste vraagt.

**Mitigatie in de code.** `AvatarProvider` is audio-first: wij leveren PCM, de vendor
rendert alleen het gezicht. Daardoor blijven STT, LLM, TTS en dus de Nederlandse
stemkwaliteit én de latency in eigen hand, en is wisselen een configuratieregel. Fase 1
bouwt bewust twee providers achter dezelfde interface, niet één.

**Mitigatie buiten de code.** Vóór er één echte cliënt op zit: DPA met verwerkingslocatie
in de EU, expliciet trainingsverbod, bewaartermijn ≤ 24 uur voor audio/video,
subverwerkerslijst, auditrecht. Blijkt dat niet haalbaar, dan is Anam binnen een dag de
vervanger — mits die tweede provider daadwerkelijk gebouwd is, en niet alleen als
mogelijkheid genoemd.

**Nieuw, 22 augustus 2026.** De bey-adapter draait nu op `@livekit/agents`. Dat verlaagt
het risico dat de vendor zijn dataframing wijzigt en wij dat als bug beleven, maar het
voegt een afhankelijkheid toe aan een framework dat óók een compleet gespreksmodel
meebrengt. De grens daartegen is expliciet: alleen `voice.DataStreamAudioOutput`, nooit
`voice.AgentSession`. Zie ADR-0011.

---

## 6. Kostengedreven misbruik van de publieke intakeroute

**Waarom dit reëel is.** Elke sessie kost echt geld vanaf de eerste seconde: ~$2–3 per
intake van twaalf minuten, waarvan het leeuwendeel avatar-minuten. Een openbare URL die
per aanroep een avatarsessie start, is een rekening die iemand anders kan opvoeren.

**Mitigatie.** `app.check_and_bump_rate_limit()` telt pogingen per gehashte IP én per
organisatie (standaard 5 per uur), en `app.create_public_intake` weigert daarboven.
`organizations.session_limits` legt maximale sessieduur (25 min),
inactiviteitstimeout (90 s), gelijktijdige sessies en een maandbudget per tenant vast.
Bij budgetoverschrijding valt het systeem terug op chat in plaats van te weigeren — een
dichte deur kost een cliënt, een chatgesprek niet.

**Nog te doen.** Een bot-check vóór sessiecreatie, en de daadwerkelijke budgetbewaking op
basis van `sessions.billed_seconds` en `llm_calls`. Die tellers staan er; de handhaving
volgt in Fase 6.

---

## 7. Een architectuurgrens die stilzwijgend niets meer afdwingt

**Waarom dit een eigen risico is.** De boundary-regels zijn de reden dat de
intake-intelligentie vendor-onafhankelijk blijft. Maar `depcruise` meldt "no dependency
violations found" net zo vrolijk wanneer de regels werken als wanneer ze nergens meer op
kunnen matchen. Een kapotte grens ziet er precies zo uit als een gezonde grens.

**Het is twee keer gebeurd.** Eerst matchte een padregel alleen resolvebare paden, zodat
een niet-gedeclareerde workspace-import erdoorheen glipte. Daarna — gevonden op 22
augustus 2026 — bleek `options.exclude` met het kale patroon `dist` de buildmap van élk
npm-pakket uit de graaf te gooien, waardoor `engine-no-vendor-sdk` en `not-to-dev-dep`
allebei op niets meer konden matchen. Beide keren was de build groen.

**Mitigatie.** `pnpm boundaries` draait sinds nu ook
`scripts/check-boundaries-effective.mjs`. Dat kijkt niet naar overtredingen maar naar de
graaf: staan er npm-dependencies in, en zijn de vendor-SDK's die we daadwerkelijk
gebruiken zichtbaar? Zo niet, dan faalt de build met de reden erbij. De controle is
geverifieerd door de regressie opnieuw te introduceren.

**Wat dit niet afdekt.** Het bewijst dat de regels ergens op kunnen matchen, niet dat elke
regel het juiste afdekt. Een nieuwe vendor-SDK die niet in `VENDOR_SDKS` staat, wordt nog
steeds nergens gemeld. Bij het toevoegen van een leverancier hoort die lijst mee.

---

## 8. Anam haalt het latencybudget in passthrough niet — 807 ms vast

**Status: open, blokkerend voor de providerkeuze.** Gemeten 22 augustus 2026.

Bij oneindig snel aanleveren kost Anam in passthrough **~807 ms** voordat er geluid uit de
avatar komt. Het budget is 180 ms p50 en 350 ms p95. Dat is 4,5× respectievelijk 2,3×
over, en het is geen tuningkwestie: 807 ms is precies wat overblijft als het aanlevertempo
geen rol meer speelt.

Het gedrag valt uiteen in twee delen (zie [ADR-0010](ADR-0010-bakeoff-harnas.md)):

- vaste vertraging D ≈ 807 ms;
- vulgrens T ≈ 730 ms audio, bevestigd door prefixproeven (400 ms geeft geen geluid,
  800 ms wel).

**Waarom dit het hele product raakt.** Risico 1 gaat over een totaalbudget van 1,2 s p50.
Als de avatarstap alleen al ~1 seconde kost — 807 ms plus de tijd om 730 ms audio te
produceren — dan is dat budget niet krap maar onhaalbaar, en is "natuurlijk aanvoelend
gesprek" geen realistische propositie meer op deze provider.

**Wat het niet oplost.** Kleinere Cartesia-chunks. De grens gaat over opgebouwde
audio-duur, niet over chunkgrootte.

**Wat de stand onzeker maakt.** Bey is nog niet gemeten — die zit vast op sessies die
niet starten (zie FASE-1-KEYS.md), en dat is de enige vergelijking die zou zeggen of
~800 ms normaal is voor audio-to-video of specifiek voor Anam. Zonder dat tweede getal is
dit een alarmerende meting zonder referentiepunt, en geen grond om Anam af te schrijven.

**Ligt het aan ons of aan hen? Gemeten, 23 augustus 2026.** In `vendor-check/` staan twee
minimale voorbeelden die de documentatie van de leverancier volgen, buiten de workspace en
zonder één import uit `@intake/*`. Voor Anam: hun SDK van een CDN, `createClient` en
`streamToVideoElement`, geen wrapper van ons.

| pad                                   | p50    |
| ------------------------------------- | ------ |
| hun voorbeeld, toon zonder aanloop    | 475 ms |
| hun voorbeeld, Cartesia-spraak (REST) | 992 ms |
| onze keten, ongesneden tape           | 609 ms |
| onze keten, bijgesneden tape          | 498 ms |

**Er is geen honderd milliseconde van ons.** Dat vermoeden hield twee toetsen niet:

1. Dezelfde meting in hún voorbeeld, met echte spraak in plaats van een toon, sprong van
   475 naar 992 ms — de audio is dus de variabele en niet de keten. De SDK-levering
   (esbuild-bundel tegenover CDN) verklaarde 36 ms.
2. De aanloopstilte van de tapes gemeten: de toon 0 ms, Cartesia via REST 434 ms, onze
   eigen tape 537 ms bij de ene synthese en 167 ms bij de volgende. Die stilte gaat als
   latency de meting in — wij starten de klok bij het versturen, de avatar speelt eerst de
   stilte af, en pas daarna kruist er iets de detectiedrempel.

Met de aanloopstilte weggesneden meet onze keten 498 ms tegen hun 475 ms. Dat verschil is
ruis. De eerdere vergelijking zette twee tapes met verschillende aanloopstilte naast elkaar
en mat vooral dat verschil. Het budget van 180 ms p50 haalt hun eigen voorbeeld evenmin,
en het eerder genoemde ~800 ms is eveneens achterhaald.

**Wat het onderzoek wél opleverde, en het is groter dan waar het naar zocht.** Cartesia zet
vóór het eerste woord stilte, en die is niet vast: dezelfde zin gaf in drie achtereen-
volgende syntheses 548, 107 en 227 ms. Het is dus gegenereerde prosodie en geen padding.
Een parameter om het uit te zetten is er niet te vinden — de API accepteert onbekende
velden stilzwijgend, dus probing levert niets, en de wisselende lengte wijst er hoe dan ook
op dat er niets vasts weg te zetten valt.

In productie ging die stilte gewoon naar de avatar en wachtte de cliënt hem uit.

**Gebouwd, 23 augustus 2026.** De Cartesia-adapter snijdt de aanloopstilte weg. Gemeten
over zeven zinnen die een assistent werkelijk zegt:

|                          | weggesneden |
| ------------------------ | ----------- |
| p50                      | 204 ms      |
| min – max                | 37 – 370 ms |
| over zeven beurten samen | 1263 ms     |

Dat is ongeveer een zesde van het totaalbudget van 1,2 s, en het is de enige post tot nu
toe die volledig in eigen beheer bleek te liggen.

**Hoe het is begrensd, want dit raakt risico 2 aan de uitgaande kant.** Alleen vóór het
eerste geluid van een beurt, nooit ertussen — stilte tússen zinnen is prosodie, en die
wegsnijden maakt van de assistent een ratelaar. De drempel ligt laag (0,003 van de volle
schaal), er blijft twintig milliseconde aanloop staan zodat een zachte medeklinker niet
wordt afgekapt, en boven twee seconden stopt het snijden: dan is er iets anders aan de hand
dan prosodie en hoort dat zichtbaar te worden.

De HUD toont per beurt hoeveel er weg ging (`aanloop -204ms`). Een snijder die zijn eigen
werk verbergt, is niet te betrappen op te veel pakken.

**Bijgewerkt, 22 augustus 2026.** Het tekstgestuurde pad is opnieuw gemeten met de
burstdetector, in dezelfde sessie en afgewisseld met passthrough: mediaan 838 ms tegen
731 ms voor passthrough. `talk()` is dus niet sneller, en de eerder gemeten 385 ms was
hetzelfde artefact als de ingetrokken 36 ms. Daarmee is er geen inconsistentie meer en
staat vast dat ~800 ms is wat de Anam-pipeline kost, ongeacht het pad. Passthrough is bij
hen geen tweederangspad.

**Volgende stappen.** (1) De bey-melding beantwoord krijgen zodat er een tweede getal komt.
(2) Bij Anam navragen of de vulgrens instelbaar is — die vraag staat in
[anam-supportmelding.md](anam-supportmelding.md).

**Tot er een tweede getal is, wordt er niet verder gemeten.** Zonder referentiepunt blijft
"800 ms is veel" een gevoel: het kan net zo goed zijn wat audio-to-video nu eenmaal kost.
Dat onderscheid bepaalt of dit een providerprobleem is of een productprobleem, en dat is
een te groot verschil om op intuïtie af te doen.

---

## 9. Het systeem bevestigt een onjuiste bewering van de cliënt

**Status: gerepareerd, 22 augustus 2026. Blijft staan als categorie.**

Een cliënt zei: _"12 x 12000 is 140000."_ De assistent antwoordde _"Ja, dat klopt"_, en de
extractie legde 140.000 vast als `vso_severance_offered` met status `confirmed` en
confidence 0,85 — inclusief een letterlijk citaat als onderbouwing. De citaatverankering
vond die zin immers netjes terug in het transcript.

**Waarom dit een eigen risico is en niet een bug.** Dit is de gevaarlijkste foutsoort in
dit product, om dezelfde reden als risico 2: hij ziet er identiek uit als een goede. De
advocaat leest een bedrag met bronvermelding en heeft geen enkele aanleiding om te
twijfelen. De bestaande controles vangen het niet — `rejectUngroundedFacts` controleert of
een feit in het transcript staat, niet of het waar is, en een verkeerd bedrag dat de cliënt
zelf heeft uitgesproken is perfect verankerd.

**Wat er is gebouwd.** Drie lagen, want een prompt is een verzoek en dit hoort een regel te
zijn.

1. `packages/domain/src/arithmetic.ts` trekt rekenkundige beweringen deterministisch na.
   Twaalf maal twaalfduizend is honderdvierenveertigduizend, ongeacht wat een model ervan
   vindt — dus dat oordeel wordt niet aan het model gevraagd.
2. Het hot path krijgt de uitkomst vóór de beurt mee en vraagt terug in plaats van te
   bevestigen. De gespreksprompt verbiedt bovendien elke bevestiging van een som, ook een
   kloppende.
3. De extractie degradeert een uitkomst die de cliënt zelf berekende: klopt de som niet,
   dan status `unknown` met het citaat behouden; klopt hij wel, dan hooguit `inferred` —
   het blijft een afleiding en geen waarneming.

**Wat dit niet afdekt.** Alleen rekenkundige beweringen in één herkenbaar patroon. Een
cliënt die zich vergist in een datum, een functienaam of een aantal dienstjaren wordt niet
gecorrigeerd, en dat hoort ook niet: het systeem verzamelt wat er gezegd is. Het verschil
is dat een som **verifieerbaar** is en de rest niet.

De onderliggende regel is breder dan deze implementatie: **het systeem bevestigt geen
bewering die het niet kan controleren, en presenteert geen afleiding als waarneming.** Bij
elke nieuwe categorie die wél te controleren valt, hoort die controle er te komen.

---

## 10. Het model gebruikt zichzelf als bron

**Status: gerepareerd, 22 augustus 2026. Blijft staan als categorie.**

De assistent vroeg _"was dat 17 januari?"_ — een datum die de cliënt nooit had genoemd.
De cliënt zei "ja". De extractie legde 17 januari vast als `summary_dismissal_date` met
status `confirmed`, en als onderbouwing stond er een citaat: **de eigen vraag van de
assistent**.

**Waarom de bestaande controle dit niet ving.** `rejectUngroundedFacts` controleerde het
citaat tegen het hele transcript, en daar staan de assistent-beurten ook in. Het model kon
dus zichzelf citeren. Een citaat uit een assistent-beurt bewijst alleen dat de assistent
iets heeft gezegd.

Dit is dezelfde familie als [risico 9](#9-het-systeem-bevestigt-een-onjuiste-bewering-van-de-cliënt),
maar een graad erger: bij de rekenfout verzon de cliënt het en kan hij zichzelf nog
corrigeren. Hier verzint het systeem het en biedt het aan ter bevestiging. Een twijfelende
cliënt zegt "ja" tegen een gezaghebbend klinkende vraag.

**Wat er is gebouwd.** Drie lagen, en de tweede kwam er alleen omdat de eerste te omzeilen
bleek.

1. Verankering gebeurt nu tegen **alleen wat de cliënt zei**. Het volledige gesprek gaat
   nog steeds naar het model — zonder de vraag is "ja" onbegrijpelijk — maar het bewijs
   moet uit een cliëntbeurt komen.
2. Een **instemming zonder inhoud** telt niet als bron. "Ja." komt wél van de cliënt, dus
   laag 1 alleen was te omzeilen door het antwoord te citeren in plaats van de vraag. Wie
   iets bevestigt, noemt het niet.
3. De gespreksprompt (v3) verbiedt het noemen van elke concrete waarde die de cliënt niet
   zelf heeft gezegd — geen datum, bedrag, naam of aantal, ook niet als voorbeeld of gok.
   De extractieprompt (v4) zegt hetzelfde vanaf de andere kant.

**Wat dit niet afdekt.** Een assistent die een verkeerde _samenvatting_ geeft van iets dat
de cliënt wél zei ("u zei dus dat u ontslagen bent" terwijl er "opgezegd" stond) wordt
hiermee niet gevangen. De regel is nu: een concrete waarde moet uit de mond van de cliënt
komen. Parafrase valt daarbuiten en is een open randgeval.

De onderliggende regel, breder dan de implementatie: **het systeem is nooit zijn eigen
bron.** Wat het zelf heeft geproduceerd, kan geen bewijs zijn voor wat het vastlegt.

---

## 11. Het meetapparaat is het zwakste onderdeel

**Status: open. Dit is een werkwijze, geen bug.**

Het meetapparaat heeft nu vijf keer een getal opgeleverd dat achteraf geen stand hield:

| getal      | wat het leek                 | wat het was                                                                                              |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| **36 ms**  | Anam passthrough, uitstekend | een kort geluidsfragment vóór de spraak, op de eerste beurt van een verse sessie                         |
| **385 ms** | Anam `talk()`, binnen bereik | hetzelfde artefact — één burst van 61 ms, spraak begon op 830 ms                                         |
| **807 ms** | Anam passthrough, ondergrens | niet fout maar achterhaald: andere dag, andere tape; opnieuw gemeten 609 ms                              |
| **−5 ms**  | onmogelijk                   | detector vuurde op audio die al speelde, want er werd op een vaste pauze gewacht in plaats van op stilte |
| **100 ms** | overhead van onze integratie | verschil in aanloopstilte tussen twee tapes; met gelijke tapes 498 tegen 475 ms                          |

Drie zijn detectorartefacten, één is een meting die door een beter beheerste opzet werd
vervangen, en de laatste is een verschil dat helemaal geen oorzaak had: twee metingen
verschilden op meer dan één ding tegelijk, en het ding waaraan het werd toegeschreven was
niet het ding.

Alle vijf zijn zelf gevonden, en dat is precies het probleem: ze hadden alle vijf ook níét
gevonden kunnen worden. De 36 ms stond een week in
[ADR-0010](ADR-0010-bakeoff-harnas.md) als bevestiging van een architectuurkeuze.

Het vijfde geval laat bovendien zien dat de regel breder moet zijn dan de detector. Daar
was de detector in orde; wat ontbrak was de controle dat twee metingen op één ding
verschilden. **Een vergelijking is pas een vergelijking als je kunt opnoemen wat er
allemaal gelijk is gehouden.**

**Waarom juist dit onderdeel.** De detector zet een continu signaal om in één moment. Dat
moment is niet te controleren aan iets anders in dezelfde meting — er is geen tweede klok,
geen checksum, geen tegenspraak. Een fout levert daarom geen foutmelding op maar een
plausibel getal. Dat is dezelfde vorm als risico 2 en risico 9: het ziet er identiek uit
als een goede uitkomst.

**De regel die hieruit volgt.** Een latencycijfer landt niet in een ADR of een beslissing
voordat het langs een tweede, onafhankelijke weg is bevestigd. "Onafhankelijk" betekent:
niet dezelfde detector met andere instellingen, maar een andere soort waarneming.

Wat er tot nu toe als tweede weg heeft gewerkt:

- **de prefixproef** voor de vulgrens van ~730 ms — een ja/nee-uitkomst (komt er geluid?)
  in plaats van een tijdstip, en die bevestigde wat de tempo-reeks aanwees;
- **de burstduur** voor de vraag of het gedetecteerde geluid wel spraak was — een klik van
  61 ms en een zin van 2040 ms geven hetzelfde onset-tijdstip;
- **het voorbeeld van de leverancier** in `vendor-check/` voor het verschil van ~100 ms —
  een volledig andere codeketen die hetzelfde meet;
- **de fasesplitsing** in `diag:ttft` voor de TTFT — headers, eerste byte en eerste tekst
  apart, waardoor zichtbaar werd dat onze SSE-verwerking niets kostte.

**Wat dit niet is.** Geen reden om minder te meten. Het is een reden om een getal niet te
gebruiken zolang er maar één weg naartoe loopt.

---

## 12. Audiokwaliteit: de keten zit vast op 16 kHz door de Cartesia-WebSocket

**Status: open. Blokkeert een kwaliteitswinst die verder gratis is.**

Live met avatar klonken er tikken en viel de kwaliteit tegen. Drie verdachten, alle drie
gemeten in plaats van beredeneerd.

**1. Het wegsnijden van de aanloopstilte — niet de oorzaak.** De golfvorm die onze TTS
verlaat is schoon: het eerste sample na het snijpunt is −5 op een schaal van 32767, en de
grootste sprong in de eerste vijf milliseconde is 16. De bewaarde aanloop van 20 ms landt
dus in near-silence. Er is toch een fade-in van 8 ms bijgezet: die kost niets en neemt de
hele klasse "sprong in de golfvorm" weg, in plaats van hem per stem opnieuw te moeten
meten. Met `TTS_TRIM_LEADING=0` is het snijden uit te zetten om met eigen oren te
vergelijken.

**2. Chunkgrenzen — niet de oorzaak.** Geen enkele chunk met een oneven aantal bytes, en de
grootste sprong óp een chunkgrens (5257) is kleiner dan de grootste sprong bínnen een
chunk (18166). Er gaat op de grenzen dus niets verloren en er ontstaat geen sprong.

**3. Samplerate — hier zit het.** Anam accepteert blijkens hun eigen type 16000, 24000 en 44100. Wij sturen 16000, en 16 kHz spraak klinkt hoorbaar doffer dan 24 kHz.

Maar het is niet zomaar op te hogen. Gemeten, dezelfde zin, drie syntheses per pad:

| gevraagde rate | REST   | WebSocket |
| -------------- | ------ | --------- |
| 16000 Hz       | 2,37 s | 2,14 s    |
| 24000 Hz       | 2,37 s | 1,39 s    |

REST schaalt het aantal samples netjes mee met de rate — de duur blijft gelijk. De
WebSocket doet dat niet: het aantal samples blijft hetzelfde, waardoor die audio op 24000
"1,39 seconde duurt". **Cartesia negeert `sample_rate` over de WebSocket en levert altijd
16 kHz.**

Wie de rate daar toch ophoogt, labelt 16 kHz-audio als 24 kHz en krijgt spraak die
anderhalf keer te snel klinkt. Dat is geen subtiel kwaliteitsverlies maar een kapot
gesprek, dus de adapter gooit nu een fout bij elke andere waarde dan 16000 in plaats van
het stilletjes te laten gebeuren.

**Wat er nog niet is verklaard.** De tikken zelf. Onze audio is schoon tot het punt waar
hij de browser verlaat, de rates komen overeen, en de chunkgrenzen kloppen. Wat overblijft
is Anams eigen verwerking: hun resampler van 16 kHz naar hun interne rate, of hun
afhandeling van chunks die wij sneller aanleveren dan realtime. Dat is niet van binnenuit
te meten en hoort een vraag aan hen te zijn.

**Wat het waard is.** Een keten op 24 kHz in plaats van 16 kHz is een merkbare
kwaliteitswinst die verder niets kost — geen latency, geen extra stap. Hij zit alleen
achter een leverancierslimiet. Vraag aan Cartesia: honoreert de WebSocket `sample_rate`,
en zo nee, hoe komen we dan aan een hogere rate zonder de streaming op te geven.

## 13. Leverancierconfiguratie die geaccepteerd wordt en genegeerd

**Waargenomen.** Anams `POST /v1/auth/session-token` antwoordt HTTP 200 op een
`personaConfig` waarin `avatarId` en `voiceId` staan, en gebruikt vervolgens alleen de
`personaId`. Gevolg: het gezicht in beeld was een ander dan het ingestelde, en de sessie
begon met een Spaanse begroeting uit hun eigen TTS. Hetzelfde geldt voor
`enableAudioPassthrough: true` bij `POST /v1/personas` — 201, en het veld staat daarna op
`false`. Een `PUT` die dat wil rechtzetten geeft 200 en verandert niets.

**Waarom het pijn doet.** Bij een normale API is een geslaagde call bewijs dat de instelling
is aangekomen. Hier niet. De fout valt daardoor pas ver van zijn oorzaak: niet bij het
configureren, maar in de browser van de cliënt — en bij audio hóór je hem alleen, er is geen
foutmelding die iemand kan lezen. Dit is dezelfde vorm als de Flux-claim in ADR-0009 en als
`personaConfig.id` destijds: een bewering die met de symptomen klopte en niet met de oorzaak.

**Wat we ertegen doen.** Configuratie bij een leverancier geldt pas als gezet nadat hij is
**teruggelezen**, en gedrag pas als bewezen nadat het is **gemeten**. Concreet:

- `assertStilBijPassthrough()` haalt de persona bij elke serverstart op en weigert te
  starten als `llmId` niet `CUSTOMER_CLIENT_V1` is;
- `pnpm --filter @intake/agent diag:stilte` opent een sessie, zegt niets, en meet of er
  toch geluid uit komt — met de tegenproef in dezelfde sessie, want "stil" is niets waard
  als onze eigen audio er ook niet doorkomt;
- `pnpm --filter @intake/agent anam:persona` leest na het aanmaken terug en faalt als het
  resultaat afwijkt van wat er gestuurd is.

**Openstaand bij hun support.** Waar dient `enableAudioPassthrough` voor, als onze audio met
`CUSTOMER_CLIENT_V1` doorkomt terwijl die vlag `false` staat? En: waarom accepteert de API
velden die hij weggooit, in plaats van 400 te geven?

## 14. Tikken in de audio van de avatar — oorzaak nog niet gevonden

**Waargenomen.** De audio die uit Anam terugkomt heeft hoorbare tikken, in elke beurt en in
elke sessie. Bij een stock-persona en bij onze eigen persona gelijk, dus het zit in hun
audioverwerking en niet in de configuratie.

**Wat is uitgesloten.** De audio die wij versturen is schoon tot en met de laatste stap voor
`sendAudioChunk()`; chunkgrenzen zijn continu; het wegsnijden van de aanloopstilte
uitzetten verandert niets.

**Het samplerate-experiment.** Wij leveren 16 kHz omdat Cartesia's WebSocket niets anders
geeft (risico 12); Anam neemt 24 kHz aan. Drie armen, twee volledige runs, tikken per
seconde in de teruggekomen audio:

| arm                                       | run 1 | run 2 |
| ----------------------------------------- | ----- | ----- |
| A · 16 kHz, de huidige weg                | 2,87  | 2,48  |
| B · 24 kHz, wij schalen zelf op vanaf A   | 1,91  | 1,59  |
| C · 24 kHz rechtstreeks van Cartesia REST | 1,98  | 2,43  |

A en B delen exact dezelfde bron en meten aan de bronkant gelijk (18 tegen 18, 21 tegen 22),
dus ons opschalen voegt zelf niets toe. De reductie van ongeveer een derde in arm B is in
beide runs dezelfde kant op. C is een andere generatie audio en gedraagt zich grillig.

**Conclusie.** Zelf 24 kHz leveren scheelt reproduceerbaar ongeveer een derde, maar **de
tikken verdwijnen niet**. De resamplingstap is hooguit een bijdrage, niet de oorzaak. Het
blijft dus een openstaande vraag bij hun support (deel A2 van de melding).

**Waarom dit nog niet in productie zit.** `upsamplePcm16` werkt op één afgesloten buffer.
Per chunk aanroepen in een streamende keten zet op elke chunkgrens een randeffect neer — je
zou tikken toevoegen op precies de plekken die je onderzoekt. Een streamende variant met
overlap is te bouwen, maar een derde minder tikken die er nog steeds zijn, weegt niet op
tegen een nieuwe verwerkingsstap in het hot path zolang de oorzaak niet bekend is.

**Wat het meetgereedschap wel en niet kan.** De teruggekomen audio is door Opus heen, dus
alleen verschillen tússen armen zeggen iets. En de detector is bewust conservatief: een tik
die midden in een sisklank valt is niet te scheiden van de sisklank zelf — gemeten steekt
zo'n tik daar 12,2× boven de lokale mediaan uit terwijl schone samples er al 14,6× halen.
De getallen zijn dus een ondergrens. Dat staat vastgelegd in een test, zodat een volgende
versie de drempel niet stilletjes kan verlagen om gevoeliger te lijken.

## 15. Relatieve tijdsaanduidingen werden datums die niemand heeft verteld

**Waargenomen.** De extractieprompt kreeg `Vandaag is <ISO>` en verder niets. Drie dingen
gingen daardoor mis, allemaal met een verkeerd of ontbrekend feit in `case_facts` als
gevolg — dus niet cosmetisch.

**1. Het was de UTC-datum.** De worker draait op UTC. Tussen middernacht en twee uur
's nachts (zomertijd) is dat een dag eerder dan in Nederland: een cliënt die om half één
"gisteren" zegt, kreeg eergisteren. De zone is nu een organisatie-instelling
(`organizations.time_zone`) en niet een constante in de code — een Belgisch of Duits kantoor
zit toevallig in dezelfde zone, maar het is een eigenschap van het kantoor.

**2. Er stond geen weekdag bij, en het model rekent die fout uit.** Gemeten tegen een vast
anker (zaterdag 22 augustus 2026), zes uitdrukkingen door de echte extractie:

| uitspraak            | verwacht   | model          |
| -------------------- | ---------- | -------------- |
| gisteren             | 2026-08-21 | 2026-08-21     |
| eergisteren          | 2026-08-20 | 2026-08-20     |
| drie weken geleden   | 2026-08-01 | 2026-08-01     |
| twee maanden geleden | 2026-06-22 | 2026-06-22     |
| afgelopen vrijdag    | 2026-08-21 | **2026-08-18** |
| vorige week maandag  | 2026-08-10 | **2026-08-18** |

Zuivere offsets gaan goed; zodra er een weekdagnaam bij komt, gaat het mis — en twee keer
dezelfde verkeerde datum is geen toeval. Er staat nu een deterministisch vangnet omheen
(`packages/domain/src/weekdag.ts`), dezelfde vorm als de rekensom-backstop: de vrijdag vóór
zaterdag de 22e is de 21e, ongeacht wat een model ervan vindt. Na het vangnet: zes van zes.
Correcties worden gemeld en niet stil doorgevoerd.

**3. Vaagheid moest een gok worden.** "Ergens in het voorjaar" is geen datum. De prompt
schrijft nu voor: geen gok, maar status `unknown` met de letterlijke uitspraak in
`evidenceQuote`. Een gegokte datum is in het dossier niet van een vastgestelde te
onderscheiden, en daar wordt een vervaltermijn op gerekend.

## 16. Twee stille paden waarlangs een verteld feit verdween

Gevonden tijdens het bovenstaande, en ernstiger dan de aanleiding.

**Een feit met status `unknown` werd nooit meer gezocht.** `gezochteFeiten` sloeg elk feit
over dat al in de map stond, ongeacht status. Maar `unknown` betekent juist _niet
vastgesteld_. Gevolg: de assistent vraagt "sinds wanneer bent u ziek?", de cliënt zegt "dat
weet ik niet precies", `sick_since` wordt vastgelegd als unknown — en als de cliënt het zich
twee beurten later herinnert, kijkt de extractie er niet meer naar. Het antwoord viel stil
op de grond en niemand zag dat het er was geweest.

**Een feit dat in dezelfde adem viel als de conditie die het ontsluit.**
`summary_dismissal_date` is pas relevant als `termination_route` op `summary_dismissal`
staat. Beide vallen in "ik ben afgelopen vrijdag op staande voet ontslagen", maar de
conditionele categorieën werden gewogen met de feiten van vóór de beurt. De datum stond dus
niet in de zoeklijst, en omdat het transcript alleen de nieuwe beurten bevat, was die
vrijdag daarna weg. Gemeten: in één beurt kwam de datum er niet uit, in twee beurten wel.

De engine doet nu één tweede extractieronde over hetzelfde transcript voor wat er net is
vrijgekomen. Eén ronde, geen lus: twee ronden dekken "conditie en waarde in dezelfde adem",
en een lus zou de kosten van het koude pad onbegrensd maken.

**Wat deze twee gemeen hebben.** Geen van beide gaf een foutmelding. Een feit dat niet wordt
gezocht ziet er precies zo uit als een feit dat de cliënt nooit heeft genoemd — en dat is
waarom ze pas boven kwamen toen er een test op relatieve datums werd gezet.

## 17. De publieke intakeroute is een uitgavenknop op internet

Zodra `/intake/[organizationSlug]` publiek staat, kan iedereen die de URL kent een gesprek
starten dat vanaf de eerste seconde geld kost: avatarminuten, STT, TTS en twee modellen. Er
is geen inlog voor, en dat is het hele punt van de route — een cliënt van het kantoor heeft
geen account.

**Wat er al staat, in tegenstelling tot wat de build-spec doet vermoeden.** De rate limiting
bestaat wél en zit in de database, niet in de applicatie: `app.check_and_bump_rate_limit`
staat vijf pogingen per uur toe per (organisatie, IP-hash), en `create_public_intake` weigert
daarbuiten. `issue_agent_session` telt daarbovenop de lopende sessies per kantoor
(`maxConcurrentSessions`, standaard 5) en begrenst de tokenduur (`maxSessionMinutes`,
standaard 25). De bovengrens per kantoor is daarmee ongeveer **vijf gesprekken tegelijk**, dus
in het slechtste geval zo'n 300 avatarminuten per uur. Dat is een bedrag, geen ramp — maar het
is wel het bedrag dat een aanvaller kan aanzetten en niet kan afzetten.

**Wat er niet staat: de bot-check.** Een headless browser kan de twee vinkjes zetten en
starten. De IP-limiet remt dat, maar iemand met een proxypool loopt er omheen: de limiet is
per adres, niet per persoon. Dit is de maatregel die nog moet komen voordat de route echt
open gaat, en het is ook de enige die het verschil ziet tussen "vijf pogingen van dezelfde
bezoeker" en "vijf pogingen van vijf apparaten".

**Twee gaten die er tot vandaag in zaten en nu dicht zijn.**

Het adres kwam uit `x-forwarded-for`, en het eerste element daarvan is geen adres maar een
bewering: elke bezoeker mag die header meesturen. De rate limiting was daarmee te omzeilen
door bij elke poging iets anders te verzinnen — de enige rem op de kosten stond dus open. De
web-app leest nu eerst de header die de rand zelf schrijft (`x-nf-client-connection-ip` bij
Netlify) en waarschuwt in de logs als die ontbreekt, in plaats van stil terug te vallen op
iets vervalsbaars. Zie `apps/web/src/lib/client-ip.ts`.

De hash was een kale SHA-256 van het adres. Er zijn 4,3 miljard IPv4-adressen; die tabel is in
een middag terug te rekenen, en dan is de "hash" alsnog een persoonsgegeven — precies wat §14
verbiedt. `INTAKE_IP_HASH_PEPPER` stond al in de envvalidatie mét deze omschrijving, maar werd
nergens gebruikt. Dat gebeurt nu wel, en zonder peper weigert de functie in plaats van stil
een kale hash te maken.

**Wat nog open staat.**

- De 25 minuten zijn een tokenduur, geen mediastop. Verloopt het token, dan falen de RPC's,
  maar de audio- en videoverbinding blijft staan tot de inactiviteitsklok afgaat of de
  bezoeker weggaat. Een bezoeker die blijft praten, blijft kosten maken.
- De inactiviteitsklok (90 s, na 30 s respijt) sluit een stille bezoeker af. Een bot die
  geluid afspeelt houdt hem eindeloos aan de praat.
- `maxConcurrentSessions` telt sessies met `ended_at is null`. Sluit een sessie niet netjes
  af — worker herstart, container weg — dan blijft die teller staan en is het kantoor op vijf
  vastgelopen sessies onbereikbaar. Faalt veilig voor de kosten, onveilig voor de dienst.
- Er is geen dagplafond. Vijf tegelijk, de klok rond, is binnen de regels.

**Wat dit praktisch betekent voor de eerste publieke deploy.** Zet `maxSessionMinutes` en
`maxConcurrentSessions` per kantoor laag zolang de bot-check er niet is, en zet bij de
avatarvendor een hard prepaid saldo in plaats van automatisch bijladen. De Cartesia-402 uit
risico 13 is hier het precedent: een leverancierslimiet komt binnen als een sessie die direct
sluit, en niet als een rekening waar iemand op tijd naar kijkt.

## 15. De draaiende worker is een demo die eruitziet als het product

**Waargenomen.** Van de negen agent-RPC's die `@intake/db-core` aanbiedt, worden er zeven
nergens aangeroepen:

| RPC                           | aangeroepen                             |
| ----------------------------- | --------------------------------------- |
| `agent_verify_session`        | ja — bij het openen van de socket       |
| `agent_end_session`           | ja — sinds 25 augustus, bij het sluiten |
| `agent_context`               | nee                                     |
| `agent_set_session_providers` | nee                                     |
| `agent_append_message`        | nee                                     |
| `agent_upsert_fact`           | nee                                     |
| `agent_set_risk_flag`         | nee                                     |
| `agent_record_metric`         | nee                                     |
| `agent_log_llm_call`          | nee                                     |
| `agent_update_progress`       | nee                                     |

**Waarom het pijn doet.** Het gesprek werkt: de cliënt praat, de assistent antwoordt, de
extractie draait, de HUD toont zes stappen. Alleen landt er niets. Na afloop staat er een rij
in `intakes` met een status en een consentrij, en verder niets — geen transcript, geen feiten,
geen onderwerp, geen urgentie, geen volledigheid, geen metriek. De dossierlijst toont vier
streepjes, en dat leest als "de extractie werkt niet" terwijl de extractie prima werkt en
alleen nergens heen schrijft.

Dat is de gevaarlijkste vorm die dit project kent: van buiten niet te onderscheiden van een
werkend product. Een demo waarin je zelf een gesprek voert, bewijst hier niets over wat er in
het dossier belandt.

**De oorzaak is één keuze, en die staat opgeschreven.** De worker die in productie draait is
`apps/agent/live/server.ts`, oorspronkelijk het ontwikkelharnas — zie `docs/deploy.md`, "Wat
nog niet klopt". Dat bestand had per ontwerp geen databasekant ("geen gezicht, geen LiveKit,
geen database"). De code die het wél doet hangt aan `src/main.ts`, en dat bestand luistert
nergens op. Elk gevolg hiervan is tot nu toe apart ontdekt: `ended_at` dat nooit werd
geschreven (risico bij `maxConcurrentSessions` hierboven), en nu vier lege kolommen.

**Wat er niet aan de hand is.** Het RPC-oppervlak zelf is af en getest: 44 isolatie-assertions
groen, `agent_update_progress` kent al `p_client_name`, `p_subject`, `p_completeness`. Er
hoeft niets ontworpen te worden; er moet bedraad worden.

**Wat dit niet oplost.** Naam en contactgegevens komen sinds 26 augustus via het
toestemmingsscherm binnen en lopen langs `apps/web`, niet langs de worker. Die kolom vult dus
wél. Onderwerp, urgentie en volledigheid blijven leeg tot deze bedrading er is.

## 16. Een gecorrigeerd feit is niet van een bevestigd feit te onderscheiden

Dit is een eigenschap van het ontwerp en niet van een storing. Hij blijft bestaan als elke
bekende bug in de barge-in-keten is opgelost.

**De vorm.** De cliënt zegt iets, de assistent verwerkt het tot een feit, en de cliënt
grijpt in om het recht te zetten. Komt die correctie niet aan — om welke reden dan ook —
dan behoudt het dossier de oorspronkelijke bewering **met een citaat dat klopt**. Het feit
is verankerd in het transcript, het citaat staat er letterlijk, en de bewering is verkeerd.

**Waarom dit een graad erger is dan risico 10.** Daar is een gegokte datum niet van een
vastgestelde te onderscheiden; de verdediging is dat een gok geen citaat heeft, en
`rejectUngroundedFacts` vangt hem daarop. Hier ís er een citaat. De cliënt heeft die woorden
werkelijk gezegd. Elke controle die wij hebben — verankering, bekende sleutel, typevalidatie
— geeft groen. De correctie liet geen spoor achter dat een advocaat kan zien, want er is
geen veld voor "hier is iets weersproken".

En de bewering is niet neutraal fout: het zijn juist de feiten die iemand wíl corrigeren die
ertoe doen. Een ontslagdatum, een bedrag, een datum waarop een termijn gaat lopen. Precies
de velden waarop een vervaltermijn wordt gerekend.

**Waarom de bestaande verdediging hier niet werkt.** `truncateToSpoken` doet zijn werk goed:
het transcript bevat alleen wat de cliënt heeft gehóórd. Dat maakt het probleem juist
scherper — de assistentbeurt klopt, de cliëntbeurt klopt, en wat ertussen verdween is
nergens geboekt. Wat wél werkt en al bestaat is de aanpalende detectie: `turn_continued`
(risico 2) meldt dat een uitspraak te vroeg werd afgekapt. Dat is dezelfde klasse signaal en
dekt een ander stuk van dezelfde weg.

**Wat er sinds 26 augustus wél gemeld wordt.**

- Een beurt die begint en eindigt zonder één bruikbaar woord geeft nu `empty_turn` met de
  reden en het aantal resultaten van de herkenner. Dat verdween eerder met een kale
  `return`: een kuch en een onverstane correctie waren van buiten allebei stilte.
- Een uitspraak die binnenkomt terwijl een interrupt loopt, wacht die interrupt af in plaats
  van hem te overschrijven. Zonder dat schreef `completeTurn` de correctie weg als de
  uitspraak die de ónderbroken beurt startte — de correctie stond dan wél in het dossier,
  op de verkeerde plek en met het verkeerde antwoord ernaast.

**Wat er niet is.** Er is geen mechanisme dat een correctie herkent als correctie. Een
cliënt die "nee, het was februari" zegt, levert een nieuwe beurt op; of het eerder
vastgelegde feit daarmee wordt ingetrokken, hangt af van wat de extractie ervan maakt. Er is
geen tegenspraakdetectie, geen versiegeschiedenis per feit, en geen markering op de
detailpagina dat een feit is gewijzigd nadat het was vastgesteld.

**Wat dit zou verkleinen, in volgorde van kosten.** Een feit dat verandert nadat het is
vastgelegd, hoort zijn vorige waarde te bewaren en zichtbaar te maken — `case_facts` heeft
al een auditspoor, dus dit is vooral een kwestie van tonen. Daarnaast: een expliciete
tegenspraakcontrole op het koude pad, die niet vraagt "wat is het feit" maar "spreekt deze
beurt iets tegen dat al vaststaat". Beide staan nog niet in de roadmap en beide zijn
groter dan een reparatie.
