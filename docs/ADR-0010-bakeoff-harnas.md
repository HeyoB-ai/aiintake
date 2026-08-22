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

**p50 ≈ 36 ms**, tegen een budget van 180 ms p50. Ruim binnen, en een orde van grootte
beter dan de 385 ms van het tekstpad. Dat verschil is precies wat je verwacht: in
passthrough doet Anam geen TTS meer, hij relayt en rendert alleen.

Het bevestigt bovendien de keuze uit ADR-0001 met een getal. Audio passthrough is niet
alleen beter voor de Nederlandse stemkwaliteit — het scheelt hier ~350 ms per beurt.

**Twee kanttekeningen.**

Dit meet de audio-omloop, niet de lipsynchronisatie. De architectuur spreekt van "eerste
avatarframe met geluid", en geluid is daarvan de meetbare helft; of het gezicht op
hetzelfde moment beweegt, is hiermee niet aangetoond. Dat vraagt frameanalyse.

En 24–43 ms is snel genoeg om achterdochtig van te worden. De verklaring is plausibel —
minimale buffering bij pure relay — maar het is één meetpunt met één detector. Bij de
uiteindelijke providerkeuze hoort dit tegen bey afgezet te worden met hetzelfde harnas,
en dat is precies waarom het harnas er is.

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
