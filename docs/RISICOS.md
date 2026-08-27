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

### 2b. Verdwijnt er spraak? Gemeten: niet in deze vormen — maar een overgeslagen beurt laat geen spoor na

**Gemeten 27 augustus 2026 met `pnpm diag:dataverlies`.**

De aanleiding was de vraag of `pad 2` zich werkelijk voordoet: `pending` stapelt uitsluitend op
`is_final`, dus een tussentijds resultaat mét woorden dat nooit definitief wordt, gaat als
`partial` naar buiten — waar alleen de barge-in naar kijkt — en verdwijnt daarna.

**Uitkomst: twaalf metingen, vier vormen, nul verlies.**

| arm                         | gebeurtenissen             |
| --------------------------- | -------------------------- |
| normaal                     | `p13 p34 p63 F64 EIND(64)` |
| kort                        | `F11 EIND(11)`             |
| zacht (12% amplitude)       | `p11 p43 p63 F64 EIND(64)` |
| afgebroken (75% van de zin) | `p18 p43 F54 EIND(54)`     |

Elke arm sloot af met tekst. Nul lege beurten met `tekensGezien > 0`, nul zwevende partials.

**Wat de proef eerst wél liet zien, en waarom dat onzin was.** In twee eerdere opzetten gaf de
afgebroken arm drie van de drie keer `p18 p44` en dáárna niets: geen final, geen beurt, geen
melding. 44 tekens verstaan Nederlands, verdwenen. Dat leek het bewijs.

Het was een eigenschap van de proef. Die stopte met audioframes sturen en wachtte daarna met een
timer — en Deepgram's stroomklok loopt op ontvángen audio, dus `UtteranceEnd` ging nooit af. In
productie stopt de microfoon niet: die stuurt de hele sessie frames, ook nullen als de poort
dicht is. Zodra de proef dat ook doet, sluit de afgebroken arm netjes met 54 tekens.

**Wat die valse uitkomst wél aantoont.** Het is precies wat er gebeurt als de audiostroom
midden in een uitspraak ophoudt — een verbinding die wegvalt, een tab die sluit, een
microfoon die wordt ingetrokken. Dan bevriest de klok en gaat het vangnet niet af. Dat is een
ander risico dan pad 2 en het is niet gemeten in productie.

**Het echte gat, en dat staat los van de STT.** Een overgeslagen beurt wordt **nergens
vastgelegd**. `onSkippedTurn` in `live/server.ts` doet één ding: `stuur({ type: 'skipped',
reden })` naar de browser. Het gaat naar het Railway-log en naar de HUD, en niet naar
`messages`. Het transcript dat een advocaat leest, heeft dus geen enkel merkteken op de plek
waar een uitspraak is overgeslagen — het leest als een doorlopend gesprek.

Dat is precies de vorm waar het bij feiten om gaat: een dossier dat er compleet uitziet en het
niet is. En het is goedkoop te sluiten: `messages.role` accepteert al `'system'`, en
`agent_append_message` neemt de rol als parameter aan — er is geen migratie voor nodig. De
demo-seed schrijft zo'n regel zelfs al, wat het des te verwarrender maakt: in de database staat
één systeemregel en die is gezaaid.

**Een fout die ik hierbij heb gemaakt en die het vermelden waard is.** Ik heb die gezaaide regel
eerst als bewijs gepresenteerd dat er in een echt gesprek een beurt was overgeslagen. Dat was
onjuist: intake `10000000-…-002` is demodata uit `supabase/seed/demo-data.mjs`. Seed en
productie staan in dezelfde tabel en zijn aan niets anders te onderscheiden dan aan het
UUID-patroon — ook dat is een risico, en het heeft hier gewerkt zoals risico's werken.

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

**Status: de premisse klopt niet meer. Gemeten 26 augustus 2026.**

> **Correctie, en die staat hier boven en niet onderaan.** De titel van dit risico en de
> `throw` in `CartesiaTtsStream.connect()` gaan ervan uit dat Cartesia's WebSocket
> `sample_rate` negeert en altijd 16 kHz levert. Dat is niet meer zo. Twee onafhankelijke
> metingen (`pnpm diag:tts-vergelijk`):
>
> - **spreektempo** — 24 kHz over de WebSocket geeft 3,83 woorden per seconde, tegen 3,41
>   voor REST op dezelfde tekst. Werd de parameter genegeerd, dan zou de berekende duur twee
>   derde van de echte zijn en het tempo boven de 5 w/s uitkomen. Dat gebeurt niet.
> - **samples op 16 tegen 24 kHz** — 128050 tegen 194676 samples over drie runs per rate,
>   een verhouding van **1,52**. Genegeerd zou 1,00 opleveren.
>
> ElevenLabs honoreert het eveneens (1,47).
>
> Dit is een **omgekeerd** eerder resultaat, geen nieuw resultaat. De oorspronkelijke meting
> staat hieronder ongewijzigd en de toenmalige uitkomst is niet in twijfel getrokken; wat
> hier is vastgesteld, is dat hij vandaag anders uitvalt. Waarom weet niemand — het kan een
> wijziging bij Cartesia zijn. Dat is precies risico 16: een gecorrigeerd feit is niet te
> onderscheiden van een bevestigd feit, en daarom staat de correctie hier bovenaan met de
> meting erbij.
>
> **Wat dit openzet.** De reden om 24 kHz niet in productie te nemen was dat het zelf
> opschalen per chunk randeffecten toevoegt op precies de plekken die je onderzoekt. Die
> reden vervalt: 24 kHz is nu rechtstreeks te vragen, zonder resamplingstap. De gemeten winst
> was ongeveer een derde minder tikken. De `throw` in `connect()` blokkeert dat vandaag nog.
>
> **Wat dit niet oplost.** De tikken verdwenen in arm B ook niet. Dat blijft staan.

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

## 17. De TTS spreekt niet betrouwbaar uit wat wij aanleveren

**Status: gewisseld naar ElevenLabs op 26 augustus 2026. Gemeten 25 en 26 augustus 2026.**

> **Wat er is gedaan.** De keten draait sinds 26 augustus op ElevenLabs; zie 17b voor de
> cijfers en 17c voor de meting ná de wissel. Cartesia blijft werkend als tweede optie. Dit
> risico blijft open en wordt niet afgevinkt: het is verplaatst naar een leverancier waarbij
> de foutvorm zich in 9 en later 10 metingen niet heeft voorgedaan, en dat is iets anders dan
> een uitgesloten fout. Onder 17c staat wat er nu nog niet gedekt is.

**Waargenomen.** Een met de hand getranscribeerde opname (`rauw.wav`, buiten onze adapter
en buiten de avatar om) miste tekst. Verstuurd:

> "Goedenavond, Heyo Beentje. Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht. Ik
> ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen."

Gehoord:

> "Heyo Beentje, ik ben AI intake assistent van van dijk arbeidsrecht. Ik ben arbeidsrecht
> om de gegevens van uw zaak vast te leggen."

**"Ik ben geen advocaat" viel weg.** Dat is de disclaimer waarvoor de cliënt op het
toestemmingsscherm een apart vinkje zet. Valt hij weg, dan maken we in gesproken vorm de
belofte niet waar die we schriftelijk hebben laten aanvinken — en de cliënt heeft geen
manier om te weten dat er iets is overgeslagen.

**Waarom duur geen bruikbare maat bleek.** De eerste opzet vergeleek de duur van drie armen.
Twee runs later gaf REST 9520 ms en daarna 7848 ms op exact dezelfde tekst: 18 procent
spreiding binnen één arm, groter dan het verschil tussen de armen. Een korter fragment
bewijst dus niets. Vandaar een rondgang — synthese terug door Deepgram, en de woorden
vergelijken.

**Wat de rondgang wél laat zien** (`pnpm diag:tts-tekst`, drie armen op dezelfde tekst):

| arm                        | wat er misging                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| REST, één aanroep          | **de hele eerste zin weg** — "Goedenavond, Heyo Beentje" ontbreekt volledig                                                |
| WS, één bericht            | eerste zin verminkt; **de staart herhaald**: "…vast te leggen en ben aangesteld om de gegevens van uw zaak vast te leggen" |
| WS, per zin (productiepad) | "Goedenavond, Heyo Beentje" → "Gooisi"; staart herhaald                                                                    |

Twee foutvormen dus, en allebei bij de leverancier: **de eerste zin is onbetrouwbaar** en
**de staart wordt herhaald**. Geen van beide hangt aan hoe wij opknippen — de arm met één
enkel bericht heeft de herhaling ook, en REST heeft de wegval zonder enige streaming.

**Wat de meting níét bevestigt.** In alle drie de armen stond de disclaimer er wél volledig
in. De wegval uit de handmatige transcriptie is dus **intermitterend en niet structureel**.
Dat maakt hem niet minder ernstig — een disclaimer die soms niet klinkt is nog steeds een
disclaimer die niet klinkt — maar het is een ander probleem dan "hij ontbreekt altijd", en
het vraagt een andere oplossing.

**Wat dit niet is.** Niet de byte-uitlijning (gemeten: nul oneven chunks in twee runs, zie
`pnpm diag:audio`). Niet het wegsnijden van aanloopstilte (die knipt op stilte, met 20 ms
marge en 8 ms fade). Niet Anam: dit is gemeten vóór de avatar.

**Wat er open staat.**

- Een vraag aan Cartesia: waarom valt de eerste zin weg en waarom wordt de staart herhaald,
  op `sonic-3` met `language: nl`? Reproduceerbaar met de tekst hierboven.
- Zolang dat niet is opgelost, is de gesproken disclaimer niet gegarandeerd. De schriftelijke
  staat op `/ai-disclosure` en wordt apart afgevinkt; dat is de enige waarborg die nu
  overeind staat, en dat hoort iemand te weten die deze intake juridisch beoordeelt.
- Een mogelijke mitigatie die nog niet is uitgewerkt: de opening niet als één synthese
  aanbieden, zodat een wegval één korte zin kost in plaats van de disclaimer. Dat is een
  ontwerpkeuze en geen reparatie — hij verkleint de kans, hij sluit hem niet uit.

### 17b. Naast ElevenLabs gelegd — dezelfde tekst, dezelfde rondgang

**Gemeten 26 augustus 2026, `pnpm diag:tts-vergelijk`.** Drie runs per arm, zes armen, negen
metingen per leverancier. Geen wisseling doorgevoerd; dit zijn de cijfers om op te beslissen.

Het instrument telt nu beide kanten op. `diag:tts-tekst` telde alleen wat er ontbrak; de
herhaalde staart heb ik daar met het oog uit een transcript gehaald, en dat is precies de
waarneming die de volgende keer wordt gemist. Er zitten nu drie maten in: ontbrekende
woorden, woorden die er niet in stonden, en de langste aaneengesloten reeks die tweemaal in
één transcript staat.

| foutvorm                                 | Cartesia | ElevenLabs |
| ---------------------------------------- | -------- | ---------- |
| "Goedenavond" ontbreekt volledig         | **7/9**  | **0/9**    |
| "geen advocaat" ontbreekt of is verminkt | **1/9**  | **0/9**    |
| herhaalde reeks van 3+ woorden           | **2/9**  | **0/9**    |

De ernstigste regel is de tweede, en niet vanwege het aantal. Cartesia REST leverde in run 2
dit:

> "Ik ben Leo Bentje, ik ben de intakeassistent van Van Dijk Arbeentje, **ik ben advocaat** en
> ben aangesteld om de gegevens van uw zaak vast te leggen."

Het woord "geen" is weg. De disclaimer zegt dan niet minder dan bedoeld — hij zegt **het
tegenovergestelde**. Van "ik ben geen advocaat" wordt "ik ben advocaat", in een gesprek waarin
de cliënt op het toestemmingsscherm juist voor die zin heeft getekend. Eén op negen.

Wat ElevenLabs mist is in alle negen metingen hetzelfde en van een andere orde: de verzonnen
naam "Heyo Beentje", en "intake assistent" dat als één woord terugkomt. Beide leveranciers
verhaspelen die naam in elke run, dus dat is een naamprobleem en geen leveranciersprobleem.
In geen enkele ElevenLabs-meting ontbreekt een zin, een groet of de disclaimer.

**Snelheid.** Eerste audio, gemiddeld over drie runs, in de productievorm (WebSocket, per zin):

| arm                     | Cartesia | ElevenLabs |
| ----------------------- | -------- | ---------- |
| WebSocket, per zin      | 123 ms   | 131 ms     |
| WebSocket, één bericht  | 139 ms   | 136 ms     |
| REST, streamend gelezen | 232 ms   | 184 ms     |

Acht milliseconde verschil op de weg die wij gebruiken. Het latencybudget is hier niet de
beslissende factor — die getallen zijn wel vanaf een werkplek gemeten en niet vanaf Railway,
dus lees ze als verhouding en niet als budgettoets.

**Spreektempo, en dat is wél een verschil.** ElevenLabs spreekt 2,45 woorden per seconde tegen
3,83 bij Cartesia. Dezelfde openingszin duurt daar 10,4 seconde tegen 7,5. Dat is ruim drie
seconde extra voordat de cliënt aan het woord komt, elke beurt opnieuw. Dat weegt tegen de
betrouwbaarheid op, en het is een keuze en geen meetfout.

**Wat deze proef niet meet.** Klemtoon en intonatie in het Nederlands. Een spraakherkenner
geeft woorden terug, geen oordeel over "ARbeidsrecht" tegen "arbeidsRECHT". Daarom schrijft
elke arm een WAV weg in `apps/agent/measurements/tts-vergelijk/`. Dat oordeel is van het oor
en staat bewust niet in de tabel.

## 18. Een leverancier wisselen kan niet zoals bij de avatars

**Status: opgelost op 26 augustus 2026, op één punt na — zie "Wat het onderzoek er los van
vond" onderaan, dat blijft open.**

> **Wat er is gedaan.** `MediaConfig` draagt nu `tts: TtsConfig` in plaats van
> `cartesiaApiKey`/`cartesiaVoiceId`; `apps/agent/src/tts-fabriek.ts` leest
> `provider_config.tts` en `provider_config.ttsVoiceId` uit en `live/server.ts` geeft ze per
> verbinding mee; de zes bestanden die naar `CartesiaTtsStream` castten doen dat niet meer —
> ze gebruikten alleen contractmethoden, dus de cast was puur ruis. `TTS_PROVIDER` overrulet
> alles voor een losse proef.
>
> De beschrijving hieronder blijft staan zoals hij was, want hij verklaart waarom het werk
> nodig was.

De vraag was of de providerlaag op een wissel is ingericht zoals bij de avatars. Het antwoord
is: het contract wel, de bedrading niet.

**Het contract is schoon.** `TextToSpeechProvider` en `TtsStream` in
`packages/providers/tts/src/contract.ts` beschrijven precies wat de lus nodig heeft — `say`,
`flush`, `cancel`, `trimmedLeadingMs`, `on`, `close` — en `turn-loop.ts` raakt niets anders
aan. Een tweede adapter is te schrijven zonder de lus te veranderen.

**De bedrading is dat niet.** Bij de avatars zit de naad in de opties:
`EchoSessionOptions.avatarProvider` wordt ingespoten en valt terug op de null-provider. Bij de
TTS bestaat die naad niet. `startEchoSession` construeert `new CartesiaTtsProvider(...)`
rechtstreeks, en `MediaConfig` draagt `cartesiaApiKey` en `cartesiaVoiceId` als **veldnamen**.
De keuze zit dus niet in een parameter maar in de vorm van het configuratietype.

**Er is een schakelaar die niemand uitleest.** `organization.settings.tts` is
`z.enum(['cartesia', 'elevenlabs', 'fake'])`, wordt in de seed op `'cartesia'` gezet en gaat
via `p_tts_provider` de database in. Geen enkele regel in `apps/agent` leest hem. Dat is
dezelfde vorm als de zeven ongebruikte agent-RPC's uit risico 15: geconfigureerd, opgeslagen,
en zonder effect.

**Wat er dan werkelijk moet gebeuren.** Een adapter schrijven, `MediaConfig` neutraal maken,
een fabriek bouwen die `settings.tts` uitleest, en de zeven testbestanden aanpassen die
`CartesiaTtsProvider` rechtstreeks construeren en naar `CartesiaTtsStream` casten. Dat laatste
is de echte maat: het zijn niet de aanroepers van het contract die vastzitten, het zijn de
plekken die het contract omzeilen.

### Wat het onderzoek er los van vond

`CartesiaTtsStream.nextTurn()` roteert de context per beurt en heeft **nul aanroepers** in de
hele repo. Dat is de derde keer dat dit patroon opduikt: `finishTurn` bij de null-avatar deed
hetzelfde en kostte ons vanaf beurt 2 van elk gesprek de `first_frame`-meting en een correcte
truncatie.

De lus roept aan het eind van een schone beurt wél `avatar.endTurn()` aan, maar niets op de
TTS. De enige andere weg naar `newContext()` is `cancel()`, en die loopt alleen bij een
barge-in. In een gesprek zonder onderbrekingen krijgt beurt 2 dus dezelfde `context_id` als
beurt 1, en die is met `continue: false` afgesloten.

**Gemeten, niet aangenomen.** Drie beurten over één socket, dezelfde tekst:

| beurt                            | audio   | woorden kwijt |
| -------------------------------- | ------- | ------------- |
| 1 · verse context                | 8081 ms | 3             |
| 2 · dezelfde context (productie) | 8173 ms | 3             |
| 3 · verse context                | 7105 ms | 5             |

Het hergebruik doet er niet toe. Cartesia accepteert een gesloten context en levert gewoon
audio. **Dit is dus niet de oorzaak van risico 17** — dat moest gemeten worden voordat het
kon worden uitgesloten, en dat is nu gebeurd.

Eén gevolg blijft wel staan, en het is klein: `newContext()` zet ook `trimming` terug op
`true`. Omdat hij na beurt 1 niet meer draait, wordt aanloopstilte alleen in de eerste beurt
weggesneden — en geeft `trimmedLeadingMs()` een sessietotaal terug op een plek waar de HUD een
beurtwaarde toont. Dat kost latency en leesbaarheid, geen woorden.

### 17c. Na de wissel, over de weg die nu draait

**Gemeten 26 augustus 2026, `pnpm diag:tts-productieweg`.**

De vergelijking in 17b praat rechtstreeks met de API's. Dat is juist om een leverancier te
kiezen, maar het is niet wat er in productie gebeurt: daartussen zitten de fabriek, het
wegsnijden van aanloopstilte, het opknippen in chunks, de contextrotatie en de sample rate.
Elk van die stappen kan woorden kosten. Een wissel die op de kale API goed meet en in de keten
iets anders doet, is geen wissel maar een verhuizing van het probleem.

Deze proef loopt door `mediaConfigFrom` en `maakTtsProvider` — dezelfde twee functies die
`startEchoSession` gebruikt. Twee beurten per run over dezelfde stream, want zo loopt een
gesprek, en de tweede raakt de contextrotatie die de lus zelf niet aanroept.

Zes metingen, `ELEVENLABS_SPEED=1.1`, 24 kHz:

| wat                            | uitkomst |
| ------------------------------ | -------- |
| "Goedenavond" weg              | 0/6      |
| "geen advocaat" weg            | 0/6      |
| herhaalde reeks van 3+ woorden | 0/6      |
| tweede beurt zonder audio      | 0/6      |
| foutmeldingen van de adapter   | 0        |

Eerste audio 99–256 ms (mediaan 127), tegen 131 ms bij de kale API — de adapter kost dus
niets. Weggesneden aanloopstilte 0–18 ms per beurt, en die waarde is per beurt en niet
oplopend: de `AanloopSnijder` reset wél in deze adapter. Wat er in alle zes de metingen
ontbreekt is "Heyo" uit de verzonnen naam, en dat deed elke arm van beide leveranciers.

**Het spreektempo, met de cijfers om aan de knop te draaien.** Dezelfde zin, door de hele
keten:

| `ELEVENLABS_SPEED`                 | duur      |
| ---------------------------------- | --------- |
| 1,0 (standaard van de leverancier) | 10,4 s    |
| **1,1 (onze standaard)**           | **9,4 s** |
| 1,2 (maximum van hun API)          | 8,4 s     |
| — Cartesia ter vergelijking        | 7,5 s     |

Het verschil is dus te verkleinen maar niet weg te nemen: op het maximum blijft er ongeveer
0,9 seconde per beurt over, niet de drie seconden waar het op de standaardinstelling stond. Op
1,2 is het resultaat nog steeds 0 op 4 voor alle drie de foutvormen, dus die keuze kost geen
betrouwbaarheid — alleen hoe het klinkt, en dat is een oordeel van het oor. De knob staat in
`ELEVENLABS_SPEED` en vraagt geen commit.

**Wat hiermee niet gedekt is.** Tien metingen zonder wegval zijn geen bewijs dat de foutvorm
niet bestaat; bij Cartesia trad hij in 1 op 9 op, dus een leverancier met 1 op 50 zou hier
gewoon schoon uit komen. Wat er nu wél staat is een instrument dat de vraag in twintig minuten
opnieuw beantwoordt, en een bewaker in de adapter die het zegt als de sample rate stil
verandert (`SpreektempoWacht`). Dat is minder dan een garantie en meer dan een aanname.

## 19. De samplerate stond op drie plekken los van elkaar

**Status: opgelost op 26 augustus 2026, dezelfde dag als de fout die hem veroorzaakte.**

**Wat er gebeurde.** De TTS ging naar 24 kHz (zie de correctie bij risico 12). Drie andere
plekken bleven op 16000 staan, alle drie als eigen kopie:

| plek               | wat er stond                                                     |
| ------------------ | ---------------------------------------------------------------- |
| `live/server.ts`   | `const SAMPLE_RATE = 16_000`, meegestuurd in het `ready`-bericht |
| `live/page.html`   | `const SR = 16000`, gebruikt in `createBuffer()`                 |
| `null-provider.ts` | `new NullAvatarSession(16_000, …)`, met de opties genegeerd      |

**Waarom niets omviel.** Alle drie de getallen zijn geldig. Typecheck groen, tests groen, de
hele reeks groen. Er kwam geluid uit de speakers — alleen anderhalf keer te traag en een
kwint te laag, want 24000 samples die als 16 kHz worden verklaard duren 1,5 seconde in plaats
van 1. Van buiten klinkt dat als een stem die langzaam praat.

**Hoe het aan het licht kwam.** Niet door een controle. Door de waarneming "1.2 klinkt nog
steeds te langzaam", en door de juiste gevolgtrekking daarbij: een tempo dat niet te
compenseren valt, wijst op een rate die niet klopt. De poging tot compensatie liep tegen de
grens van ElevenLabs' API (0,7–1,2, hard geweigerd boven 1,2) — dat was een tweede symptoom
van dezelfde oorzaak en geen los probleem.

**De tweede schade, en die is erger dan het geluid.** `NullAvatarSession.bufferedMs` kwam er
anderhalf keer te hoog uit. Dat is de bovengrens waarmee `truncateToSpoken` bepaalt wat de
cliënt heeft gehóórd. Het transcript legde dus meer als gehoord vast dan er klonk — dezelfde
klasse als de `finishTurn`/`endTurn`-fout, en met dezelfde onzichtbaarheid.

**Wat er nu staat.**

- `AvatarSessionOptions.sampleRate` is een **verplicht** veld. Geen terugval, want optioneel
  met een default is precies de vorm waarin dit stil misgaat. Drie aanroepers werden er een
  compilefout van; dat is het bewijs dat het veld werkt.
- `server.ts` leidt `SAMPLE_RATE` af van `media.tts.sampleRate`, en het `ready`-bericht meldt
  `mediaketen.tts.sampleRate` — de rate van díé sessie, inclusief een kantoor met een andere
  leverancier.
- `page.html` heeft `SR_IN` (microfoon, echt 16 kHz) gescheiden van `SR_UIT` (van de server).
  `SR_UIT` begint op `null` en audio vóór `ready` geeft een zichtbare fout in plaats van een
  gok. De uitvoercontext krijgt geen opgelegde rate meer, zodat de browser niet alles naar
  16 kHz terugrekent.
- `null-provider.test.ts` heeft twee tests die op de oude code faalden (1500 in plaats van
  1000 ms).
- `pnpm samplerate:check` draait vóór elke push, naast `db:status`.

**Waarom een controle en niet een betere toelichting.** Boven het `ready`-bericht stond op het
moment van de fout al, letterlijk: _"twee plekken met hetzelfde getal is hoe een mismatch
ontstaat, en een mismatch klinkt hier als spraak die te snel of te traag loopt."_ Die
waarschuwing stond er, was juist, en hielp niets — want het getal dat werd meegestuurd was
zélf de tweede kopie. Een toelichting is geen bewaker.

**Wat de controle niet kan.** Hij leest tekst en voert niets uit; hij ziet dus niet of de
doorgegeven rate ook de juiste ís, alleen dat er geen tweede bron voor in de plaats is
gekomen. Dat de sessie met de meegegeven rate rékent staat in `null-provider.test.ts`; dat de
synthese levert wat ze belooft in `pnpm diag:tts-productieweg`. Los dekt geen van de drie de
keten.

## 20. Het startpunt van de worker kwam door geen enkele poort

**Status: opgelost op 26 augustus 2026, dezelfde dag als risico 19.**

**Wat er gebeurde.** De reparatie van risico 19 zette `const SAMPLE_RATE = media.tts.sampleRate`
op moduleniveau, 28 regels bóven `const media`. Op Railway crashte de worker daardoor bij elke
herstart:

```
var SAMPLE_RATE = media.tts.sampleRate;
TypeError: Cannot read properties of undefined (reading 'tts')
```

In TypeScript is dat een temporal-dead-zone-fout; esbuild bundelt `const` naar `var` en dan is
het stilletjes `undefined` in plaats van een `ReferenceError`.

**Waarom dat op zichzelf al fout was.** Ook een afgeleide constante is een tweede plek waar het
getal woont. Hij bevriest bij het laden van de module wat per sessie hoort te worden bepaald,
en een kantoor met een andere leverancier zou hem niet meer meekrijgen — precies waar risico 19
over ging. Er staat nu geen constante meer; wie de rate nodig heeft, vraagt hem aan de
mediaketen van de sessie.

**Waarom geen enkele poort hem zag.** Twee gaten, en ze verklaren elk een deel.

_Eerste gat: `live/` stond niet in de tsconfig._ `apps/agent/tsconfig.json` had
`include: ["src/**/*.ts", "bakeoff/**/*.ts"]`. Gemeten met `tsc --listFiles`: 1219 bestanden
gecontroleerd, **nul** eronder in `live/`. Het startpunt van de worker is dus nooit
getypecheckt — niet die dag, niet ooit. Zet je `live/` erin, dan meldt tsc de crash meteen, op
de goede regel:

```
live/server.ts(80,21): error TS2448: Block-scoped variable 'media' used before its declaration.
live/server.ts(80,21): error TS2454: Variable 'media' is used before being assigned.
```

Er stonden ook vier oudere fouten in dat bestand: `Parameters<typeof createServer>[0]` komt
door de overloads uit op `ServerOptions` in plaats van `RequestListener`. Die stonden er
maandenlang en niemand kon ze zien.

_Tweede gat, en dat is het zwaardere: niets startte de worker ooit._ `build:worker` bundelt met
esbuild, dat types **stript** zonder ze te controleren, en daarna draaide er niemand
`dist/worker.js` tot Railway het deed. Een typecheck vangt een typefout; hij vangt geen
ontbrekende omgevingsvariabele, geen import die in de bundel anders uitpakt, en geen fout die
pas bij het uitvoeren van moduleniveau ontstaat.

**En de controle die ik er de dag ervoor voor had gezet, bevestigde de fout.**
`check-samplerate.mjs` eiste letterlijk `const SAMPLE_RATE = media.tts.sampleRate;`. Hij keek
of de constante een afgeleide was, niet of hij er hoorde te zijn — en groen betekende dus dat
de crash op zijn plek stond. Die eis is omgekeerd: er hoort geen constante te zijn.

**Wat er nu staat.**

- `live/**/*.ts` in de tsconfig, plus de negen andere bestanden die buiten beeld stonden
  (vitest-configs, `packages/ui/preview/`). `rootDir` van `@intake/db` en `@intake/ui` naar de
  pakketmap. Alle zestien pakketten typechecken groen.
- `pnpm typecheck:dekking` — voor elk pakket: valt elk `.ts`-bestand binnen een `include`?
- `pnpm worker:start-check` — start `dist/worker.js` en wacht op `/health`. Zonder de sleutels
  meldt hij dat en laat door, zoals `db:status`.
- Beide draaien vóór elke push. Beide zijn getoetst op de echte fout: de typecheck geeft
  TS2448/TS2454, de startproef geeft _"DE WORKER KOMT NIET OVEREIND: het proces stopte met
  afsluitcode 1 — TypeError: Cannot read properties of undefined (reading 'tts')"_. De
  startproef had hem gevangen zónder de tsconfig-reparatie, want hij draait de bundel die naar
  productie gaat.

**De vorm om te onthouden.** Dit is dezelfde als `build:netlify` en `db:status`: een poort die
een ander pad neemt dan productie, en daardoor groen wordt over iets anders dan wat er draait.
Drie keer nu. De remedie is elke keer dezelfde geweest — laat de poort het echte pad nemen —
en de kosten van hem niet nemen ook: een deploy die stukgaat op iets wat lokaal in seconden
zichtbaar was.

## 21. `speechMs` meet niet wat de naam zegt, en daardoor werkt geen van de barge-in-drempels

**Status: open, gemeten 27 augustus 2026 met `pnpm diag:bargein`.**

**De aanleiding.** De assistent onderbrak vaker, en dat begon rond de samplerate-reparatie. De
hypothese: `INTERRUPT_MIN_SPEECH_MS = 180` stond effectief anderhalf keer ruimer toen de audio
te traag liep, en vuurt nu op de bedoelde tijd.

**Die hypothese klopt niet.** In `echo-session.ts` staat:

```ts
stt.on('start_of_turn', () => {
  speechStartedAt = now();
});
stt.on('partial', (text) =>
  loop.onClientSpeech({
    speechMs: Math.round(now() - speechStartedAt),
    text,
  }),
);
```

`now()` is `performance.now()` — wandklok. De microfoonketen loopt op 16 kHz en is door de
samplerate-reparatie nooit geraakt; die zat aan de afspeelkant. De drempels zijn dus niet
meegeschaald.

**Wat er wél aan de hand is, en het is erger.** `speechMs` is niet de duur van de spraak. Het
is de wandkloktijd tussen Deepgram's `SpeechStarted` en de aankomst van het eerste
interim-resultaat: netwerkretour plus hun interim-cadans. De naam zegt "hoe lang praat de
cliënt al"; de waarde zegt "hoe lang deed de leverancier erover om iets terug te sturen".

Gemeten, zes runs per arm, op ware snelheid met stilte eromheen:

| arm                                          | partial gekregen | `speechMs`   | besluit                          |
| -------------------------------------------- | ---------------- | ------------ | -------------------------------- |
| zin — "Wacht even, dat klopt niet helemaal." | 6/6              | 565–973 ms   | interrupt, `word_count`          |
| één woord — "Wacht."                         | 3/6              | 2741–2778 ms | interrupt, `speech_duration`     |
| backchannel — "Ja."                          | 3/6              | 1568–1594 ms | **interrupt**, `speech_duration` |
| ruis — energie zonder taal                   | 0/6              | —            | komt nooit bij `classifySpeech`  |

**Drie dingen volgen hieruit, en ze zijn alle drie ernstig.**

_1. De drempel is niet te verhogen; de grootheid is verkeerd._ De waarde is **omgekeerd
evenredig** met hoeveel er gesproken is: een hele zin geeft ~600 ms, één woord ~2750 ms, omdat
Deepgram bij weinig spraak langer wacht voordat hij een interim stuurt. Wie
`INTERRUPT_MIN_SPEECH_MS` verhoogt om kort geluid te weren, maakt het juist makkelijker voor
kort geluid en moeilijker voor een echte zin. Er bestaat geen waarde die doet wat bedoeld is.

_2. De backchannel-rem is dood._ `isBackchannel()` weigert zodra `durationMs >= 400`, en die
`durationMs` is dezelfde verkeerde grootheid. Gemeten voor "ja": 1568 ms. De lijst met
"ja", "mm-hm", "precies" wordt dus wel doorlopen maar slaat nooit aan — **elke bevestiging is
een harde onderbreking**. Dat is precies het gedrag dat de toelichting bij `barge-in.ts` zegt
te willen voorkomen: "hij valt stil bij elk 'ja'".

_3. Of één woord onderbreekt, is een muntworp._ Bij korte uitingen stuurt Deepgram in de helft
van de runs helemaal geen interim maar meteen een final, en dan bereikt het `classifySpeech`
nooit. 3 van de 6.

**Wat er níét misgaat.** Kuchen en ademen leiden niet tot een harde onderbreking: er komt geen
transcript, dus geen `partial`, dus geen besluit. Ze wekken wel `SpeechStarted` en dempen de
avatar via `duck()` — en dat is omkeerbaar, zoals bedoeld.

**Waar de getallen vandaan komen.** `INTERRUPT_MIN_SPEECH_MS`, `INTERRUPT_MIN_WORDS` en
`BACKCHANNEL_MAX_MS` staan in de eerste domeincommit (`da6800e`), met een verwijzing naar §7
van de spec. Er is geen meting die ze onderbouwt — dezelfde herkomst als het latencybudget,
waarvan ADR-0012 al zegt dat het een aanname is.

**Wat dit niet verklaart.** De timing. De drempels stonden vóór de samplerate-reparatie precies
zo verkeerd als erna, dus dit verklaart de gevoeligheid maar niet waarom het gedrag toen is
veranderd. Eén kandidaat, niet getest: de microfoon staat open terwijl de assistent praat — de
poort in `conversation-client.ts` is een ruisdrempel op RMS en geen demping tijdens het spreken
— en de enige bescherming is de echo-onderdrukking van de browser. Haar audio klinkt sinds de
reparatie op de juiste snelheid en toonhoogte; wat daarvan in de microfoon lekt, is nu
verstaanbaar Nederlands en daarvóór anderhalf keer te traag en een kwint te laag. Dat is met
bestanden niet te meten — daar zijn een echte luidspreker en microfoon voor nodig.

### 21b. Verstelbaar gemaakt, niet gerepareerd

**27 augustus 2026.** De zeven drempels in dit pad zijn af te stellen zonder deploy, want dit is
gedrag dat alleen op gehoor te beoordelen is. Dat is uitdrukkelijk **geen** oplossing voor wat
hierboven staat: `speechMs` blijft netwerkretour meten in plaats van spraakduur, en geen enkele
waarde repareert dat. Het maakt de vraag onderzoekbaar.

| variabele                   | standaard | wat het doet                                     |
| --------------------------- | --------- | ------------------------------------------------ |
| `INTERRUPT_MIN_SPEECH_MS`   | 180       | duurtak van `classifySpeech`                     |
| `INTERRUPT_MIN_WORDS`       | 2         | woordtak van `classifySpeech`                    |
| `BACKCHANNEL_MAX_MS`        | 400       | de enige rem op "ja" en "mm-hm"                  |
| `DEEPGRAM_ENDPOINTING_MS`   | 300       | hoe snel de beurt van de cliënt sluit            |
| `DEEPGRAM_UTTERANCE_END_MS` | 1000      | het vangnet, én het venster van de afkapdetector |
| `MIC_GATE_RMS`              | 0.005     | de microfoonpoort in de browser                  |
| `MIC_GATE_CLOSE_MS`         | 120       | idem                                             |

De laatste twee staan in de browser en gaan mee in het `ready`-bericht. Zonder dat zou de helft
van het pad een webdeploy per poging kosten terwijl de rest in Railway te verzetten is.

**De standaard blijft de standaard.** De constanten in `@intake/domain` veranderen niet; een
variabele is een afwijking. Leeg laten — wat Railway doet als je een waarde wist in plaats van
verwijdert — telt als niet gezet, anders zou `Number('')` er stilzwijgend een nul van maken.

**Weigeren bij onzin.** Een verkeerde stand hoor je pas in een gesprek en niet in een
foutmelding, dus de worker start niet en noemt álle klachten tegelijk met de reden van de grens
erbij. Wie drie variabelen zet, wil niet drie keer opnieuw deployen om ze een voor een te horen.

**De opstartbanner** toont alle zeven met een `*` bij wat afwijkt en de standaard erachter.
Zonder dat is "welke stand stond er tijdens dat gesprek" achteraf niet te beantwoorden, en dan
is het afstellen zelf niets waard.

**De eerste proef die de moeite waard is:** `BACKCHANNEL_MAX_MS` op ongeveer 2000. Gemeten komt
een bevestiging rond 1570 ms binnen, dus dat is de enige waarde die de rem laat aanslaan.

**Wat een echte oplossing zou moeten doen** (niet doorgevoerd; dit is een voorstel, geen
reparatie):

- De duurtak voeden met de werkelijke spraakduur uit Deepgram's woordtijdstempels (`start` en
  `duration` op het resultaat) in plaats van met de wandklok, of hem laten vervallen en alleen
  op woorden beslissen.
- `isBackchannel()` op diezelfde echte duur laten oordelen, anders blijft de rem dood.
- Beslissen wat er moet gebeuren als er geen interim komt maar meteen een final — dat pad
  bestaat vandaag niet en is de helft van de korte uitingen.

## 22. De assistent vroeg om een document dat nergens naartoe kan

**Status: de belofte is weg, het uploaden bestaat nog niet. Vastgesteld 27 augustus 2026.**

De assistent vroeg een cliënt of hij zijn ontslagbrief kon uploaden. Dat kan niet, en het is
nooit gebouwd.

**Wat er wél is.** Een tabel `documents` met alle beperkingen erop, een tabel
`document_analysis`, een privé bucket `intake-documents` (20 MB, vier mime-types), zeven
RLS-policies, `agent_context` dat een documentenlijst teruggeeft, TypeScript-typen, twee
UI-componenten waarvan er één een echte `<input type="file">` heeft, een "Bewijsstukken"-sectie
op de dossierpagina, en drie auditacties.

**Wat er niet is.** Eén enkele aanroep die een bestand naar opslag schrijft. `.storage.from(`
komt nul keer voor in de hele repo. Geen upload-RPC in enige migratie, geen route of
serveractie die een bestand aanneemt, geen magic-byte-validatie, geen `insert into documents`
buiten de demo-seed. `DocumentUploadSection` — de component mét het bestandsveld — wordt
nergens in `apps/web` gemonteerd; hij bestaat alleen in de etalage en in zijn eigen tests.

De migratie zegt zelf hoe het bedoeld was, en waarom het zo niet werkt:

> De cliënt uploadt niet rechtstreeks naar storage: de server valideert eerst magic bytes en
> schrijft daarna met een service-role client. Daarom géén anon-policy.

Die server bestaat niet. De policies staan op `to authenticated` en vragen `INTAKE_STAFF`; een
cliënt is anoniem. Er is dus geen pad, en dat is een ontwerpkeuze die alleen nooit is afgemaakt
— documenten staan in fase 4 van de roadmap.

**De knop.** Op het gespreksscherm stond "Document uploaden", permanent `disabled`, met een
`title` die uitlegde dat het later komt. Op een telefoon verschijnt die tooltip nooit. Wat
overbleef was een grijze knop die niets doet en niets zegt — en de cliënt die zijn brief erbij
zoekt, concludeert dat hij zelf iets fout doet. De knop is weggehaald; hij komt terug wanneer
er iets achter zit.

**Waar de vraag vandaan kwam, en dit was de verrassing.** Niet uit de gespreksprompt — daar
staat het woord document niet in. Uit de **feitcatalogus**:

> `has_employment_contract`, hint nl: _"Heeft de cliënt de arbeidsovereenkomst bij de hand om
> te uploaden?"_

Die hint gaat als kandidaatvraag naar het model, dus het woord kwam letterlijk uit de code. De
hint is nu _"Heeft de cliënt de arbeidsovereenkomst zelf in bezit?"_ — het feit blijft, want of
iemand zijn contract heeft is bruikbaar voor de advocaat; alleen de toezegging kan niet.

**Wat er nu tegen staat.**

- Een regel in de gespreksprompt die uitdrukkelijk verbiedt om documenten te vragen, aan te
  bieden ze te ontvangen, of te zeggen dat het later kan. Met de vervangende gedragslijn erbij:
  noemt de cliënt een stuk, vraag dan naar de inhoud — wat staat erin, welke datum, van wie.
- `geen-uploadbelofte.test.ts`: geen enkel label of hint in de catalogus mag de cliënt om een
  bestand vragen. Met een test die aantoont dat de detector kan afgaan, want anders is "nul
  overtreders" niet te onderscheiden van een test die niets aanraakt.

**Wat hiermee niet is opgelost, en het is meer dan het lijkt.**

- `apps/agent/src/intake-session.ts` geeft `documents: []` hardgecodeerd aan de engine. Ook als
  er ooit een document ligt, ziet het gesprek het niet.
- `knownFromDocuments` in de planner — bedoeld om niet opnieuw te vragen wat al uit een stuk
  blijkt — wordt door geen enkele aanroeper gevuld. Dode code.
- De dossierpagina zet `summary: ''` en `extractedFacts: []` hardgecodeerd; `document_analysis`
  wordt nooit gejoind. Het tabblad "feiten" in de documentweergave is dus structureel leeg,
  zelfs met een rij in de database.
- Er zijn twee zaadrijen in `documents` die naar opslagpaden wijzen waar **nul objecten**
  achter zitten. Een demo-intake toont daarmee "Bewijsstukken (2)" zonder bestand.
- `purge_after` en `documentRetentionDays` worden nergens afgedwongen.
- De seed registreert een prompt `document.analysis` waarvoor geen sjabloon bestaat en die
  niemand aanroept.

**De vorm om te onthouden.** Dit is dezelfde als risico 15 (zeven ongebruikte RPC's) en risico
18 (een schakelaar die niemand uitleest): infrastructuur die er af uitziet omdat het schema, de
policies en de UI er zijn, terwijl het stuk dat ze verbindt ontbreekt. Het verschil is dat het
hier niet bij een lege kolom bleef — de assistent deed er een toezegging over aan een cliënt.

## 23. Seed en productie staan in dezelfde tabellen en zijn niet te onderscheiden

**Status: gemarkeerd, niet gescheiden. 27 augustus 2026.**

Het heeft een ronde gekost. Bij het onderzoek naar verdwijnende spraak heb ik een systeemregel
uit de database aangehaald als bewijs dat er in een echt gesprek een beurt was overgeslagen. Die
regel kwam uit `supabase/seed/demo-data.mjs`. De conclusie die erop volgde was onjuist, en er is
een halve ronde overheen gegaan voordat dat opviel.

Het is niet alleen een onderzoeksprobleem. Een advocaat die het dashboard opent, ziet
demo-intakes tussen de echte staan — met urgentie, volledigheid en status. Wie daarop een
werkvoorraad inschat, telt zaken mee die niet bestaan.

**De goedkope weg, en waarom niet de eerlijke.** Een kolom `is_demo` zou beter zijn, maar die
vraagt een migratie, moet op elke tabel terugkomen, en moet door élke schrijfweg correct worden
gezet — inclusief de wegen die er later bij komen. Meer oppervlak om fout te doen dan het
probleem groot is.

De seed gebruikt vaste UUID's met een herkenbare vorm: `…-0000-4000-a000-…`. Bij een echte
v4-UUID zijn die middengroepen willekeurig; de kans dat een echt gesprek die vorm treft is
ruwweg één op tienduizend miljard. `isDemoId()` in `@intake/domain` herkent hem, en het
dashboard zet er een aantekening bij.

**Wat dat niet is.** Geen bewijs en geen beveiliging — het is een aanwijzing. En geen filter: er
verdwijnt niets uit het dashboard. Een overzicht dat stilletjes rijen weglaat is een nieuw soort
onbetrouwbaar.

De test bewaakt vooral de dure kant: een écht id mag nooit als demo worden bestempeld, want dan
verdwijnt een echte intake achter een aantekening die zegt dat hij niet bestaat.

## 24. "Onderwerp" heeft geen bron

**Status: open. Vastgesteld 27 augustus 2026.**

De kolom `intakes.subject` bestaat, staat op het dashboard en in de intakedetailpagina, en
`agent_update_progress` heeft er een parameter voor (`p_subject`). Er is niets dat hem vult.

Doorzocht: `packages/intake-engine`, `packages/domain`, `packages/prompts`. Geen enkele
component levert een onderwerp. De feitcatalogus heeft categorieën en feiten, geen samenvattende
noemer; de engine geeft kandidaten, feiten, risicovlaggen en volledigheid terug, en verder
niets.

**Waarom hij niet is meegenomen in deze ronde.** Een onderwerp afleiden vraagt een oordeel:
"ontslag op staande voet" is een samenvatting van meerdere feiten, en dat is werk voor een model
of voor een deterministische regel over de catalogus. Beide zijn te bouwen; geen van beide is
te improviseren tijdens het aansluiten van twee RPC's. `updateProgress` stuurt daarom bewust
alleen `completeness` mee — `p_subject` blijft `null` en de kolom blijft leeg.

Dat is de eerlijke stand. Een onderwerp verzinnen uit de eerste cliëntzin zou de kolom vullen en
er iets neerzetten wat niemand heeft vastgesteld — precies de klasse fout die risico 16 en 22
beschrijven.

**Wat er wél moet gebeuren, in volgorde van eerlijkheid:**

1. Deterministisch, uit de catalogus: de hoogst gescoorde beantwoorde categorie als noemer.
   Traceerbaar en saai, maar grof.
2. Een koude-weg-model met gesloten schema en een citaat, zoals de feitextractie. Duurder, en
   het levert een onderwerp op dat een advocaat kan nagaan.

Tot dat er is, hoort de kolom leeg te blijven en niet gevuld met een gok.

## 25. Dezelfde tijd werd op twee plekken anders uitgerekend

**Status: opgelost op 27 augustus 2026.**

De dossierpagina toonde _"Ontvangen 27-08-2026, 11:53"_ voor een gesprek van 13:53. De
transcriptregels ernaast toonden 13:53:38.

**De oorzaak is niet de ontbrekende tijdzone.** Die stond op geen van de zes plekken. Wat het
verschil maakte, is wáár de code draaide:

| plek                                       | soort component         | zone die hij nam   |
| ------------------------------------------ | ----------------------- | ------------------ |
| `page.tsx` (Ontvangen, tijdlijn, auditlog) | server                  | UTC, want Netlify  |
| `transcript.tsx`                           | client (`'use client'`) | die van de browser |
| `dashboard/page.tsx`                       | server                  | UTC                |
| `data.ts` (uploadedAt)                     | server                  | UTC                |

`new Date(x).toLocaleString('nl-NL')` neemt zonder `timeZone` de zone van de omgeving. Dezelfde
uitdrukking gaf dus twee antwoorden, en welke je kreeg hing af van een architectuurdetail dat
niets met tijd te maken heeft. Dat is erger dan een verkeerde zone: een verkeerde zone is
overal even verkeerd en valt daardoor op.

**Waarom dit meer is dan cosmetiek.** Twee uur is bij een tijdstip een ongemak. Bij een
vervaltermijn is het soms een dag: dinsdag 00:30 Amsterdamse tijd is in UTC maandag 22:30, en
dan telt een advocaat een dag verkeerd op een termijn die niet meeschuift met een weergavefout.

**Wat er nu staat.**

- `packages/domain/src/tijd.ts` — vier functies (`datumTijd`, `datumTijdSeconden`, `alleenDatum`,
  `alleenTijd`) met **`timeZone` als verplicht argument**. Geen standaardwaarde: een parameter
  met een terugval is precies de vorm waarin dit stil misgaat. Dezelfde afweging als bij
  `AvatarSessionOptions.sampleRate`.
- De zone komt uit `organizations.time_zone` en loopt via `Membership.timeZone` naar elke
  pagina. Een kantoor in een andere zone ziet zijn eigen tijd; een advocaat die vanuit Lissabon
  inlogt, ziet kantoortijd en niet de zijne.
- `data.ts` formatteert niet meer zelf maar geeft de ruwe waarde door — dat was de tweede plek.
  `transcript.tsx` krijgt de zone als prop mee in plaats van hem af te leiden.
- `pnpm tijd:check`, vóór elke push. Hij vangt `toLocaleDateString`, `toLocaleTimeString`,
  `Intl.DateTimeFormat` en een `toLocaleString` op iets datumachtigs, overal behalve in de bron.
- `tijd.test.ts`: hetzelfde moment in drie zones, en het geval waarin twee uur een dag scheelt.

**Wat de controle níét kan.** Hij leest tekst en ziet dat er geen tweede rekenwijze bijkomt —
niet of de zone die wordt doorgegeven de juiste is. De eerste versie sloeg bovendien aan op
`arithmetic.ts`, dat `toLocaleString` op een **getal** gebruikt om een bedrag leesbaar te maken.
Een detector die getallen voor tijden aanziet, wordt uitgezet; vandaar dat `toLocaleString`
alleen telt als er op dezelfde regel iets datumachtigs staat. Waterdicht is dat niet, en dat
staat in het bestand.

**De vorm om te onthouden.** Dit is risico 19 opnieuw: één grootheid, meerdere plekken die hem
zelf uitrekenen, en niets dat rood wordt als er een bijkomt. Daar was het de samplerate op drie
plekken, hier de tijdzone op zes. Vierde keer dat deze vorm iets kost.

## 26. Een gebroken getal naar een `int`-kolom kostte twee openingsbeurten

**Status: opgelost op 27 augustus 2026.**

```
bericht 0/assistant (338 tekens) · NIET WEGGESCHREVEN:
invalid input syntax for type integer: "20702.458333333336"
```

**De kolom.** `messages.spoken_ms`, een `int`, via `p_spoken_ms int` in
`agent_append_message`.

**Waar de waarde vandaan komt.** `turn-loop.ts` telt per chunk `chunk.durationMs` op in
`emittedMs`, en die duur is `(samples / rate) * 1000`. Op 16 kHz komt dat neer op
`samples / 16` en viel het altijd rond; op 24 kHz werd het `samples / 24` en dus meestal niet.
De samplerate-wissel van 26 augustus maakte een fout zichtbaar die er al zat.

**Waarom juist deze weg.** Er zijn vier wegen naar dezelfde grootheid, en **drie ervan rondden
al wél af**: `cancel()` in de Cartesia-adapter, `cancel()` in de ElevenLabs-adapter en
`interrupt()` in de null-avatar. Alleen de schone beurt — `spokenMs: this.emittedMs` — deed het
niet, en dat was vanaf de andere drie niet te zien.

Dat is dezelfde vorm als risico 19 (samplerate op drie plekken) en risico 25 (tijdzone op zes).
Vijfde keer deze week.

**En de grootte klopt.** Gemeten met `diag:tts-productieweg`: 163 tekens in 9400 ms bij
`ELEVENLABS_SPEED=1.1`, dus 57,7 ms per teken. 338 tekens × 57,7 = 19 500 ms verwacht; gemeld is
20 702 ms, ofwel 61,2 ms per teken. Dat is 6 procent verschil en valt binnen de spreiding die
diezelfde proef liet zien. Het getal is dus juist en alleen het type was fout.

**Wat er wél uit die rekensom volgt, en dat is een aparte bevinding.** De canonieke opening is
225 tekens; deze beurt was er 338. Het model levert dus een langere opening dan ontworpen, en
de cliënt wacht daardoor **twintig seconden** voordat hij aan het woord komt. Dat is geen
typefout maar een gespreksprobleem, en het is met deze meting voor het eerst hard: elke honderd
tekens extra kosten bijna zes seconden stilte aan het begin.

**Wat er nu staat.**

- Afgerond waar de waarde ontstaat: `completeTurn` voor `spokenMs`, en een `ms()`-helper in
  `metrics.ts` voor alle zes de latencyvelden. Niet vlak voor de insert — een conversie op de
  rand van de database verbergt dat de grootheid zelf misschien niet klopt, en dan leest niemand
  meer of die twintig seconden ook echt kloppen.
- `agent_record_metric` doet `(p_metrics ->> 'x')::int` op zes kolommen, en die waarden zijn
  rauwe `performance.now()`-verschillen. Die RPC wordt nog nergens aangeroepen, dus daar had de
  fout nog niet toegeslagen — hij stond klaar voor het moment dat iemand hem aansloot.
- `hele-milliseconden.test.ts`: een echte beurt door de lus met chunkduren van 1024 samples op
  24 kHz (42,666… ms) en een klok met fracties. Getoetst dat beide tests falen op de oude code.

**Wat dit niet oplost.** Het faalde nét: leesbare melding, sessie liep door, en alleen de
openingsbeurt ontbrak. Dat viel op omdat iemand toevallig in het log keek. Een mislukte
transcriptregel hoort zichtbaar te zijn zonder logboek — vergelijk risico 2b, waar een
overgeslagen beurt inmiddels wél een regel in het transcript krijgt. Voor een mislukte
schrijfactie bestaat dat nog niet.
