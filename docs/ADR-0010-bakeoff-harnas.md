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

De per-beurt meting (audio → mondbeweging) is de volgende stap en vraagt een lopende
sessie waarin audio wordt aangeleverd.

### Wat het harnas onderweg zelf opleverde

Drie metingen snel achter elkaar liepen stuk. Oorzaak: de pagina sloot de Anam-sessie
nooit af, dus ze stapelden op tot het maximum aantal gelijktijdige sessies. Dat is niet
alleen een testprobleem — een sessie die blijft staan kost avatarminuten door, en dat is
60–80% van de variabele kosten. `stopStreaming()` staat nu in een `finally`.

## Openstaand, en het blokkeert de bey-helft

De Beyond Presence-sessie komt niet op gang. `POST /v1/sessions` slaagt (201), maar de
status blijft op `to_start`; hun worker verschijnt kort in de room, verdwijnt, komt terug
en publiceert nooit een videotrack. Reproduceerbaar over meerdere runs, met de
stockavatar Fjolla (`available`, `public`) en ook met een ruimer avatartoken.

Reproductie: `apps/agent/scripts/diagnose-bey.mjs`. Dit is een vraag voor hun support en
niet iets om omheen te bouwen — zolang dit staat, is er geen bey-meting, met of zonder
browserharnas.
