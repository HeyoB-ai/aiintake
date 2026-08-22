# ADR-0011 — Beyond Presence via @livekit/agents, en waar die library ophoudt

**Status:** aanvaard
**Datum:** 2026-08-22

## Aanleiding

De eerste bey-adapter publiceerde een audiotrack in een LiveKit-room en ging ervan uit
dat de avatarworker zich daarop zou abonneren. Er kwam nooit een frame. Mijn eerste
diagnose was dat het aan hun kant lag.

Die diagnose was fout, en dat was voorspeld: bij Anam was de fout ook een veldnaam die de
API accepteerde en de SDK weigerde. Dezelfde klasse fout lag hier meer voor de hand dan
een defect bij de leverancier. De API-referentie zegt bovendien letterlijk: gebruik dit
endpoint niet direct, gebruik de LiveKit-plugin.

Lezen van die plugin (eerst `livekit-plugins-bey/avatar.py`, daarna de JS-versie
`@livekit/agents-plugin-bey@1.7.0`) leverde drie fouten op, alle drie aan onze kant:

1. de audio gaat over een LiveKit **DataStream** naar de avatardeelnemer, niet over een
   gepubliceerde audiotrack;
2. het avatartoken heeft `kind: "agent"` nodig plus het attribuut
   `lk.publish_on_behalf` met onze eigen identity;
3. het endpoint is `/v1/session` (enkelvoud), met `livekit_url` en `livekit_token`.

## Besluit

De adapter gebruikt `voice.DataStreamAudioOutput` uit `@livekit/agents`. Het dataprotocol
bouwen we niet zelf na: framing die een vendor mag wijzigen hoort een `pnpm update` te
zijn, geen debugsessie.

Wat we **niet** overnemen is `voice.AgentSession` — de klasse waar hun eigen plugin op
leunt. Die brengt een compleet gespreksmodel mee: agent, chatcontext, turn detection, hun
eigen STT/LLM/TTS-knopen. Zou onze turn-loop daarop gaan draaien, dan verhuist de
intake-intelligentie van `packages/intake-engine` naar een vendor-framework, en werkt de
chat-fallback niet langer identiek aan de videomodus (ADR-0001).

De prijs van die knip is dat wij zelf de room, het token en de levenscyclus regelen. Dat
is ongeveer tachtig regels, en ze staan in `apps/agent/src/avatar/beyondpresence.ts`,
achter `AvatarProvider`.

## De prijs is breder dan die tachtig regels

De eerste bakeoff-run faalde hierop:

```
TypeError: logger not initialized. did you forget to run initializeLogger()?
  bij new voice.DataStreamAudioOutput
```

`voice.DataStreamAudioOutput` roept in zijn constructor `log()` aan, en die gooit als er
niets is geïnitialiseerd. Hun worker-bootstrap doet dat normaal — en dat is precies het
stuk dat wij overslaan. Opgelost met een idempotente `zorgVoorLogger()` in de adapter,
die dezelfde globale sleutel gebruikt als zijzelf, zodat een echte agent-worker in
hetzelfde proces onze logconfiguratie niet tegenkomt als verrassing.

**Dit is geen bug in de library en ook geen incident.** Het is de vorm die deze keuze
aanneemt: wij gebruiken één klasse uit een framework dat ervan uitgaat dat zijn eigen
opstartpad is doorlopen. Elk stuk impliciete initialisatie dat `AgentSession` voor je doet
— logging nu, morgen misschien een tracer, een metrics-registry of een
achtergrondtaakplanner — komt bij een upgrade als een harde fout in onze adapter naar
boven, niet als een gedragsverandering.

Dat is een aanvaardbare prijs, en het is de goede kant om op te falen: een ontbrekende
initialisatie gooit meteen en zichtbaar, terwijl het alternatief — de intake-intelligentie
in hun gespreksmodel hangen — pas maanden later zichtbaar zou worden als een chat-fallback
die anders antwoordt dan de videomodus. Maar het betekent wel dat een upgrade van
`@livekit/agents` een bakeoff-run verdient en niet alleen een groene typecheck.

## Twee dingen die dit onderweg opleverde

**`spokenMs` komt nu van de kant die het weet.** `clearBuffer()` stuurt een RPC naar de
avatarworker; die antwoordt met `playbackPosition` — hoeveel er daadwerkelijk is
afgespeeld. Dat verving onze eigen bufferboekhouding, die een schatting was. Er is een
terugvalpad met timeout, want het antwoord loopt over het datakanaal en kan uitblijven;
dat pad kapt de assistent-beurt liever te laat af dan te vroeg.

**Een echte bug in de turn-loop.** Bij een normaal beurteinde riep de lus
`avatar.interrupt()` aan, puur om aan een `spokenMs` te komen. Bij de null-provider viel
dat niet op. Bij een echte provider stuurt dat een "gooi je buffer leeg" op het moment dat
de laatste zin nog afspeelt — de cliënt zou het slot van elke beurt missen en de HUD zou
groen blijven. Daar staat nu `endTurn()`, een optionele methode op `AvatarSession` die het
audiosegment afsluit.

## De grens is gecontroleerd, en hij was kapot

De opdracht was expliciet: `@livekit/agents` mag de `AvatarProvider`-abstractie niet
ondermijnen, en de boundary-regel moet dat afvangen — controleer of hij dat ook doet.

Hij deed dat niet. Een import van `@livekit/agents` in `intake-engine` werd wél gemeld,
maar via `no-unresolvable` (het pakket stond niet in package.json), niet via
`engine-no-vendor-sdk`. Het geval dat de vendorregel moet afvangen — iemand voegt de SDK
netjes aan package.json toe en importeert hem dan — bleek groen. Twee oorzaken:

1. de vendorpatronen waren geankerd op `^`, terwijl dependency-cruiser een geïnstalleerd
   pakket als `node_modules/<naam>/...` rapporteert;
2. `options.exclude` bevatte het kale patroon `dist`, dat de buildmap van élk npm-pakket
   uit de graaf gooide. `@livekit/agents` (dist/) verdween, `zod` (lib/) bleef. Daardoor
   kon géén enkele regel met `dependencyTypes: ['npm']` nog vuren — ook `not-to-dev-dep`
   niet.

Beide zijn gerepareerd. Daarna is de proef herhaald met een gedeclareerde, geïnstalleerde
dependency, en toen vuurde `engine-no-vendor-sdk` wel.

Dat een regel twee keer stilzwijgend krachteloos is geweest, is het echte probleem: een
groene build zei niets. Daarom draait `pnpm boundaries` nu ook
`scripts/check-boundaries-effective.mjs`, dat niet naar overtredingen kijkt maar naar de
graaf zelf — staan de npm-dependencies erin, en zijn de vendor-SDK's die we gebruiken
zichtbaar? Die controle is geverifieerd door de regressie opnieuw te introduceren.

## Gevolgen

- `@livekit/agents` en `@livekit/agents-plugin-bey` zijn dependencies van `apps/agent`.
  De plugin is als referentie geïnstalleerd; de adapter importeert alleen `@livekit/agents`.
- `createAccessToken` accepteert nu `kind` en `attributes` als platte claims.
- Het avatartoken kreeg `canPublishData: true`. Dat is geen ruimhartigheid: zonder
  datakanaal komt de `lk.playback_finished`-RPC nooit aan en is `spokenMs` verzonnen.
- De bey-helft van de bakeoff kan gedraaid worden. Dat gebeurt vanaf een machine in
  Nederland, niet in CI (ADR-0010).
