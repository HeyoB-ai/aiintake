# ADR-0010 — De bakeoff moet in een browser draaien, niet in Node

**Status:** voorgesteld · **Datum:** 22 augustus 2026 · **Fase:** 1

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

## Openstaand, en het blokkeert de bakeoff

De Beyond Presence-sessie komt niet op gang. `POST /v1/sessions` slaagt (201), maar de
status blijft op `to_start`; hun worker verschijnt kort in de room, verdwijnt, komt terug
en publiceert nooit een videotrack. Reproduceerbaar over meerdere runs, met de
stockavatar Fjolla (`available`, `public`) en ook met een ruimer avatartoken.

Reproductie: `apps/agent/scripts/diagnose-bey.mjs`. Dit is een vraag voor hun support en
niet iets om omheen te bouwen — zolang dit staat, is er geen bey-meting, met of zonder
browserharnas.
