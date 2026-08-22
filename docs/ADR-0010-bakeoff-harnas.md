# ADR-0010 — De bakeoff moet in een browser draaien, niet in Node

**Status:** aanvaard en gebouwd · **Datum:** 22 augustus 2026 · **Fase:** 1

## Context

De bakeoff moet één getal opleveren per provider: de tijd tussen "wij leveren audio" en
"het gezicht beweegt". Dat getal bestaat niet in de vendorclaims — Beyond Presence meet
streaming inference, Anam meet agent-responstijd, en geen van beide meet wat de cliënt
ervaart.

Bij het bouwen van de twee adapters bleek dat de providers fundamenteel verschillende
transportmodellen hebben.

**Beyond Presence — LiveKit, serverzijdig.** Wij maken een room, publiceren een
audiotrack, en `POST /v1/sessions` met `transport: livekit` nodigt hun worker uit. Die
abonneert op onze audio en publiceert video terug in dezelfde room. Alles is vanuit Node
te doen en dus vanuit Node te meten.

**Anam — eigen WebRTC, browserzijdig.** `POST /v1/engine/session` levert een eigen
engine-host, een eigen signalling-WebSocket en eigen ICE-servers:

```
engineHost         connect-eu.anam.ai/v1/webrtc/engines/anam-engine-...
signallingEndpoint /v1/webrtc/engines/anam-engine-.../ws
region             eu
```

De verbinding wordt opgezet door hun browser-SDK. Er is geen server-transport waarin wij
een audiotrack kunnen publiceren.

## Het probleem

Twee providers met verschillende transporten zijn niet met hetzelfde harnas te meten. En
een meting die per provider anders tot stand komt, is geen vergelijking.

Concreet dreigt dit: bey meten we vanuit Node (werkt), Anam meten we niet (kan niet), en
dan komt er een "bakeoff" uit waarin één provider een getal heeft en de andere een
voetnoot. Dat is geen keuze maken, dat is de keuze laten bepalen door welke API het
makkelijkst vanuit Node te benaderen is.

## Voorstel

**Meet beide in een browser, met Playwright.**

Een pagina die per provider:

1. audio aanlevert uit hetzelfde WAV-bestand — dezelfde Nederlandse zin, dezelfde
   lengte, dezelfde bitrate;
2. de videotrack ontvangt en het tijdstip van het eerste geverfde frame vastlegt
   (`requestVideoFrameCallback`, niet `onloadeddata` — dat laatste vuurt vóór er beeld
   is);
3. hetzelfde meet: audio erin → eerste frame eruit.

Voor bey gaat de audio via een LiveKit-room, voor Anam via hun SDK. Het transport
verschilt, de meting niet.

### Waarom niet de andere kant op

_Anams signalling nabouwen in Node_ is de andere optie: hun WebSocket-protocol
implementeren bovenop `werift` of `@roamhq/wrtc`. Dat is ongedocumenteerd werk aan een
protocol dat kan wijzigen, voor een meting die we één keer doen. Als de uitkomst is dat
we Anam kiezen, moet het alsnog in de browser draaien — want daar draait het product ook.

_Alleen bey meten_ is geen bakeoff, en zou bovendien de reden wegnemen om twee providers
achter dezelfde interface te bouwen.

## Wat dit betekent voor de `AvatarProvider`-interface

De interface blijft goed voor bey en voor de null-provider: audio erin, video eruit,
`interrupt()` met `spokenMs`. Voor Anam is hij vanuit Node niet waar te maken, en de
implementatie **gooit expliciet** in plaats van te doen alsof.

Dat is een bewuste keuze. Een `createSession()` die compileert, netjes teruggeeft en geen
audio doorgeeft, zou de bakeoff stilzwijgend vervalsen: bey meetbaar, Anam
onmeetbaar-maar-groen. Liever een fout die uitlegt waar het serverzijdige deel wél voor
bedoeld is.

Het serverzijdige deel van Anam is er wel en is bruikbaar: `issueSessionToken()` en
`createEngineSession()`. Dat is precies wat een browserclient nodig heeft, met de
API-key veilig op de server — hetzelfde principe als ADR-0007.

## Eerste meting

Het harnas draait. Anam, drie runs achter elkaar vanaf een machine in Nederland:

|     | sessie → eerste geverfd frame |
| --- | ----------------------------- |
| 1   | 1045 ms                       |
| 2   | 1021 ms                       |
| 3   | 1038 ms                       |

Resolutie 576×384. Stabiel binnen ~25 ms.

**Wat dit getal wél en niet is.** Dit is de **koude start**: sessie opzetten, WebRTC
onderhandelen, eerste frame. Het is níét de stap uit de latencybegroting — die meet
audio erin tot mond beweegt, binnen een sessie die al loopt. Naast het p50-budget van
180 ms leggen zou alarmerend ogen en niets betekenen.

Waar het wél over gaat: **hoeveel prewarm-tijd je nodig hebt.** De architectuur zegt dat
de sessie start zodra de cliënt het toestemmingsscherm opent, en dat die 8–15 seconden
leest. Eén seconde koude start past daar ruim in. Dat is het antwoord dat dit getal
geeft, en het is een geruststellend antwoord.

### Per beurt — het getal dat wél tegen het budget mag

Binnen een sessie die al draait, gemeten van opdracht tot hoorbaar geluid. Detectie via
een AnalyserNode op de ontvangen audiotrack en niet via een SDK-event: een event zegt
"ik heb je opdracht aangenomen", de RMS-drempel zegt "er komt geluid uit", en dat laatste
is wat de cliënt hoort.

|     | opdracht → hoorbaar |
| --- | ------------------- |
| 1   | 378 ms              |
| 2   | 397 ms              |
| 3   | 393 ms              |
| 4   | 251 ms              |

**p50 ≈ 385 ms**, tegen een budget van 180 ms p50 en 350 ms p95. Drie van de vier runs
zitten boven p95.

**Maar dit is een bovengrens, geen eindoordeel.** De meting gebruikt `talk()`, het
tekstgestuurde pad: Anam doet daar zelf de TTS. Onze architectuur gebruikt audio
passthrough — wij leveren PCM en zij renderen alleen (ADR-0001, want de Nederlandse
stemkwaliteit moet in eigen hand blijven). In die modus valt hun TTS uit de keten, en de
gemeten 385 ms bevat dus tijd die wij niet gaan betalen.

### Passthrough — het productiepad

Gemeten via `createAgentAudioInputStream({ encoding: 'pcm_s16le', sampleRate, channels })`:
onze eigen Cartesia-audio erin, op ware snelheid aangeleverd, en meten wanneer er geluid
uit de avatar komt.

|     | onze audio erin → hoorbaar eruit |
| --- | -------------------------------- |
| 1   | 38 ms                            |
| 2   | 43 ms                            |
| 3   | 24 ms                            |
| 4   | 34 ms                            |

> **INGETROKKEN, 22 augustus 2026.** Deze tabel is onjuist. Zie hieronder.

Destijds schreef ik hierbij: "24–43 ms is snel genoeg om achterdochtig van te worden…
het is één meetpunt met één detector." Die achterdocht was terecht, en ik heb hem niet
doorgezet.

### Wat er werkelijk stond te gebeuren

Bij twaalf beurten in één sessie kwam eruit: 34, 27, dan oplopend 300–550, dan 931 en 1528. Een diagnose die per beurt níét alleen het onset-tijdstip vastlegt maar ook de
**duur** van elk stuk hoorbaar geluid, wees de oorzaak aan:

```
conditie        beurt  onset   verzonden  bursts (start/duur)
nieuw/400       0      287     2121       291/290   1581/1930
nieuw/400       1      1363    2120       1368/2050
nieuw/2500      1      1370    2120       1375/2041
hergebruik/400  1      1116    2121       1121/480  1742/1710
```

De brontape is 2136 ms. In vrijwel elke beurt staat één burst van ~2040 ms die begint op
**~1360 ms**. Dát is de avatar die onze zin afspeelt. De korte burst van 290 ms in beurt 0
is iets anders — en dáár ging de oude detector op af.

De 24–43 ms was dus geen latency. Het was een artefact vóór de spraak, gemeten op de
eerste beurt van een verse sessie, wat de vier oorspronkelijke runs toevallig allemaal
waren. Het getal van 435 ms uit de latere twaalf-beurtenrun was net zo goed fout: een
mengsel van dat artefact en de staart van de vorige beurt.

**Een onset-tijdstip zonder duur is geen meting.** Een klik van tien milliseconden en een
gesproken zin van twee seconden geven hetzelfde getal. De detector registreert nu bursts
met begin én duur, en de conclusie "dit is de avatar die spreekt" is toetsbaar geworden in
plaats van aangenomen.

### Wat het niet is

De vorm leek op een wachtrij die zich opbouwt. Dat is het niet:

- **De pauze tussen beurten doet er niet toe.** 400 ms en 2500 ms geven dezelfde ~1360 ms.
  Was het onze wachtrij, dan had een langere pauze het weggenomen.
- **Eén audiostroom hergebruiken maakt het slechter, niet beter.** Die conditie geeft
  gesplitste bursts (1121/480 gevolgd door 1742/1710) en meer spreiding. Een nieuwe stroom
  per beurt is het schonere pad.

### De openstaande vraag, en waarom die het getal kan halveren

Het harnas levert de audio op **ware snelheid** aan: 2120 ms voor 2136 ms tape. Dat leek
zorgvuldig — "alles in één keer dumpen zou de meting vertekenen" — maar het is niet wat de
turn-loop in productie doet. Daar gaat Cartesia-audio naar de avatar zodra hij binnenkomt,
en dat is sneller dan realtime.

De gesplitste bursts verraden bovendien dat 1× voeden marginaal is: de avatar begint,
loopt leeg en hervat. Dat is buffer-underrun, en dat is een eigenschap van mijn
aanlevering, niet van hun product.

Daarmee staat de kernvraag open, en die is niet cosmetisch:

- **vaste vertraging** — de avatar wacht ~1360 ms ongeacht hoe snel wij leveren, of
- **buffervulling** — de avatar wacht tot hij ~1360 ms aan audio heeft, en dan zakt de
  wandkloktijd evenredig mee zodra wij sneller leveren.

Bij de tweede is de productielatency een fractie van dit getal. Bij de eerste zit Anam met
1360 ms zeven keer over het budget van 180 ms, en is passthrough geen oplossing maar een
probleem. Eén experiment scheidt die twee: dezelfde tape aanleveren op 1×, 4× en zo snel
mogelijk, en kijken of het onset-tijdstip meebeweegt.

### Het experiment, en de uitkomst

Dezelfde tape op vier tempo's, drie beurten per tempo, één sessie. Brontape 1765 ms.

| tempo | onset (wandklok) | voorspeld door `D + T/S` |
| ----- | ---------------- | ------------------------ |
| 1×    | 1540 ms          | 1540 ms                  |
| 2×    | 1125 ms          | 1173 ms                  |
| 4×    | 965 ms           | 990 ms                   |
| max   | 807 ms           | 807 ms                   |

Het is **allebei**, en dat maakt het antwoord ongemakkelijker dan de vraag toeliet:

- een **vaste vertraging D ≈ 807 ms**, die blijft staan hoe snel we ook leveren;
- een **vulgrens T ≈ 730 ms audio**, die met het tempo meeschaalt.

De prefixproeven bevestigen T langs een onafhankelijke weg. Alleen een prefix insturen en
de stroom bewust níét afsluiten, zodat `endSequence()` geen flush forceert:

| prefix  | geluid?               |
| ------- | --------------------- |
| 200 ms  | nee, binnen 5 s niets |
| 400 ms  | nee, binnen 5 s niets |
| 800 ms  | ja                    |
| 1600 ms | ja                    |

De grens ligt tussen 400 en 800 ms. Dat is waar de fit hem zet.

### Wat dit betekent

**Blokkerend, geen tuningkwestie.** Zelfs bij oneindig snel aanleveren kost Anam in
passthrough ~807 ms voordat de cliënt iets hoort. Het budget is 180 ms p50 en 350 ms p95.
Dat is 4,5× respectievelijk 2,3× over, en die 807 ms is niet weg te tunen — het is wat er
overblijft als het aanlevertempo geen rol meer speelt.

**Kleinere Cartesia-chunks leveren niets op.** De grens gaat over opgebouwde
audio-duur, niet over chunkgrootte. De avatar heeft ~730 ms aan audio-inhoud nodig,
ongeacht in hoeveel stukjes die aankomt. Wat wél helpt is dat Cartesia die 730 ms sneller
produceert; hoe fijn we hem daarna hakken, verandert niets.

**Voor de productielatency** betekent dit: 807 ms vast, plus de tijd die Cartesia nodig
heeft om 730 ms audio te maken. Bij een generatietempo van ~4× realtime is dat ~180 ms
erbij, dus reken op ~1 seconde voor de avatarstap alleen.

### De inconsistentie is beslecht: er was er geen

`talk()` opnieuw gemeten met de burstdetector, in dezelfde sessie, in blokken afgewisseld
met passthrough zodat sessiedrift geen van beide bevoordeelt. Brontape 2879 ms.

| pad         | mediaan    | spreiding    |
| ----------- | ---------- | ------------ |
| passthrough | **731 ms** | 655 – 824 ms |
| `talk()`    | **838 ms** | 405 – 1148   |

`talk()` is niet sneller. Als er al verschil is, is het de andere kant op, en het
tekstpad is bovendien veel grilliger — logisch, want daar zit hun TTS in de keten.

**Passthrough is bij Anam dus geen tweederangspad.** ~800 ms is simpelweg wat hun pipeline
kost, welk pad je ook neemt. De keuze uit ADR-0001 om de TTS in eigen hand te houden kost
ons niets in latency; hij levert alleen geen winst op.

**En de 385 ms is verklaard.** In deze reeks staat één rij die het laat zien:

```
talk B        405      0     0    —    410/61   830/850   1991/925
```

Onset 405 ms, maar de eerste burst duurt **61 ms**. Dat is het artefact; de echte spraak
begint op 830 ms. Een detector zonder duurinformatie leest dat als "405 ms latency". Zo is
de 385 ms ontstaan, en zo is de 36 ms ontstaan. Het is dezelfde fout, twee keer.

### Gevolg voor het harnas

Het `1×`-aanleveren is eruit, aan beide kanten. Het harnas levert nu zo snel als het kan,
want dat is wat de turn-loop doet: Cartesia-audio gaat door zodra hij binnenkomt. Ruim
zevenhonderd milliseconde van de eerdere meting was mijn eigen aanlevertempo.

### Kanttekening die blijft staan

Dit meet de audio-omloop, niet de lipsynchronisatie. De architectuur spreekt van "eerste
avatarframe met geluid", en geluid is daarvan de meetbare helft; of het gezicht op
hetzelfde moment beweegt, is hiermee niet aangetoond. Dat vraagt frameanalyse.

### Wat het harnas onderweg zelf opleverde

Drie metingen snel achter elkaar liepen stuk. Oorzaak: de pagina sloot de Anam-sessie
nooit af, dus ze stapelden op tot het maximum aantal gelijktijdige sessies. Dat is niet
alleen een testprobleem — een sessie die blijft staan kost avatarminuten door, en dat is
60–80% van de variabele kosten. `stopStreaming()` staat nu in een `finally`.

## De bey-helft: het lag aan ons

Eerder stond hier dat de Beyond Presence-sessie op `to_start` bleef staan en dat dit een
vraag voor hun support was. **Dat was voorbarig.** Na het napluizen van hun documentatie
en de officiële LiveKit-plugin blijkt het een integratiefout aan onze kant, en wel op
drie punten tegelijk.

De API-referentie van `/v1/sessions` zegt het zelf, en dat had ik moeten lezen:

> Tip: do not to use this directly, use the LiveKit plugin instead.

Uit de plugin (`livekit-plugins-bey`, `avatar.py`) blijkt wat die extra doet:

**1. Audio gaat over een LiveKit DataStream, niet over een gepubliceerde audiotrack.**
Dit is de grote. Wij publiceerden een audiotrack en verwachtten dat hun worker zich
daarop zou abonneren. De plugin gebruikt `DataStreamAudioOutput(room,
destination_identity=<avatar>, wait_remote_track=VIDEO)` — de audio wordt als
databerichten naar de avatar-deelnemer gestuurd. Hun worker kwam dus binnen, vond niet
waar hij op wachtte, en bleef idlen. Precies het gedrag dat we zagen.

**2. Het avatartoken mist het attribuut `publish_on_behalf`.** De plugin zet dat op de
identity van de agent, zodat de avatar publiceert namens ons. Ook zet hij
`kind: "agent"` op het token.

**3. De plugin gebruikt `POST /v1/session` (enkelvoud) met `livekit_url` en
`livekit_token`**, niet `/v1/sessions` met `url` en `token`. Beide bestaan; de eerste is
wat in productie gebruikt wordt.

Dit is dezelfde klasse fout als bij Anam, waar `personaConfig.id` door de API werd
geaccepteerd en door de SDK geweigerd: een payload die formeel klopt en functioneel niet.
Een 201 betekende hier niet "het werkt", maar "het is aangenomen".

**Les.** Bij een integratie die niet werkt terwijl de API 201 teruggeeft, is de eerste
vraag niet "is de vendor stuk" maar "gebruik ik het pad dat zij zelf gebruiken". Er lag
een officiële plugin die het antwoord bevatte.

**Wat er nog moet gebeuren.** De adapter herbouwen op DataStream-audio in plaats van een
audiotrack, met het juiste token-attribuut en het endpoint dat de plugin gebruikt. Het
LiveKit-dataprotocol voor audio moet daarbij vanuit Node worden nagebouwd, of we nemen
`@livekit/agents` erbij, dat `DataStreamAudioOutput` al bevat. Dat laatste is
waarschijnlijk goedkoper en minder foutgevoelig.

`apps/agent/scripts/diagnose-bey.mjs` blijft staan als reproductie van de oude,
verkeerde aanpak — nuttig om tegen af te zetten zodra de nieuwe werkt.

---

## Nabrander: dit harnas heeft vier keer een artefact geleverd

De ingetrokken tabel hierboven was de eerste. Er kwamen er nog drie, en het patroon staat
nu als [risico 11](RISICOS.md) in de risicolijst: de burstdetector is het zwakste onderdeel
van het meetapparaat, omdat een fout er geen foutmelding van maakt maar een plausibel
getal.

De regel die daaruit volgt geldt met terugwerkende kracht ook voor dit ADR: **een
latencycijfer hoort hier niet in te staan voordat het langs een tweede, onafhankelijke weg
is bevestigd.** De prefixproef deed dat voor de vulgrens; het leveranciersvoorbeeld in
`vendor-check/` deed dat voor het verschil tussen hun keten en de onze.
