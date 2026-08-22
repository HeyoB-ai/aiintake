# Wat er aan accounts nodig is voor Fase 1

Fase 1 draait nu volledig op de `null`-avatarprovider en fakes: de beurtcyclus,
barge-in met transcript-truncatie, de zinsflusher, de latencymeting en het synthetische
barge-in-harnas werken zonder één API-key en zonder netwerk.

Wat er níét zonder kan is het enige dat Fase 1 uiteindelijk moet opleveren: **een
gemeten latency vanuit Nederland op Nederlandse audio, per avatarprovider.** Dat is een
meting, geen implementatie — dus daar zijn accounts voor nodig.

Hieronder per leverancier: welke variabelen, waarvoor, en wat het concreet deblokkeert.
Alles staat al in `.env.example`.

---

## 1. LiveKit — transport (hoogste prioriteit)

```
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
```

**Waarvoor.** De WebRTC-room waarin de avatarvideo en de cliëntaudio samenkomen. De
web-app mint hiermee een room-token voor de browser; de agent-worker sluit aan als
tweede deelnemer.

**Deblokkeert.** Alles waarvoor geluid daadwerkelijk van en naar een browser moet. Zonder
LiveKit blijft de lus binnen het proces en meet je de netwerkstap niet.

**Let op bij aanvragen.** Kies een **EU-regio**. Elke trans-atlantische hop kost 80–120 ms
in élke beurt, en dat is een tiende van het hele budget.

---

## 2. Deepgram — spraakherkenning

```
DEEPGRAM_API_KEY=
DEEPGRAM_MODEL=flux
```

**Waarvoor.** Streaming STT met **model-native end-of-turn**. Dat is de reden voor
Deepgram en niet iets anders: een vaste stiltedrempel van 700 ms is 700 ms die je in
elke beurt betaalt, of de cliënt nu klaar is of niet.

Ook nodig voor **keyterm prompting**. De Nederlandse juridische termenlijst staat al
klaar in `packages/providers/stt/src/keyterms.ts` — 39 termen waar een algemeen
Nederlands model voorspelbaar over struikelt ("vaststellingsovereenkomst",
"deskundigenoordeel", "aanzegverplichting"). Die lijst is nu ongebruikt.

**Deblokkeert.** De eerste stap van de latencybegroting (endpointing, budget p50 220 ms)
en de vraag of het jargon overeind blijft.

---

## 3. Cartesia — spraaksynthese

```
CARTESIA_API_KEY=
CARTESIA_VOICE_ID=
```

**Waarvoor.** Nederlandse TTS met lage time-to-first-audio. De zinsgewijze flushing die
dit moet benutten, is gebouwd en getest; wat ontbreekt is de verbinding.

**Deblokkeert.** Stap 3 van de begroting (budget p50 80 ms) en — belangrijker — de
harde eis dat `cancel()` binnen 50 ms stilte oplevert. Dat getal is met een fake niet
te bewijzen; het hangt volledig af van hoe de leverancier annulering afhandelt.

**Alternatief.** ElevenLabs Flash v2.5 (`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`). De
moeite waard om beide te nemen: de stemkwaliteit in het Nederlands verschilt hoorbaar en
dat oordeel kun je niet op papier vellen.

---

## 4. Beyond Presence — avatar, primair

```
BEY_API_KEY=
BEY_AVATAR_ID=
AVATAR_PROVIDER=beyondpresence
```

**Waarvoor.** Het gezicht, in Speech-to-Video-modus: wij leveren PCM, zij renderen. De
`AvatarProvider`-interface is daarop gebouwd, dus dit is een adapter en geen herbouw.

**Deblokkeert.** De laatste stap van de begroting (eerste frame, budget p50 180 ms) en
daarmee het enige getal dat er echt toe doet: spraakeinde → sprekend gezicht.

**Vraag bij het aanvragen meteen om de DPA.** Hun privacybeleid zegt niets over
sessiedata — geen opslaglocatie, geen bewaartermijn, geen trainingsverklaring. Dat moet
contractueel dicht vóór er één echte cliënt op zit: EU-verwerking, expliciet
trainingsverbod, bewaartermijn ≤ 24 uur voor audio/video, subverwerkerslijst,
auditrecht. Zie [RISICOS.md](RISICOS.md) risico 4.

**Doorlooptijd.** Een eigen avatar loopt via support en kost naar verluidt 2–3 weken.
Vraag dat nu aan, ook als je eerst met een stockavatar demonstreert.

---

## 5. Anam — avatar, tweede in de bakeoff

```
ANAM_API_KEY=
ANAM_AVATAR_ID=
```

**Waarvoor.** De bakeoff vraagt om twee providers achter dezelfde interface. Eén
provider meten levert een getal op zonder vergelijking, en de vendorclaims meten
aantoonbaar niet hetzelfde ding: "<100 ms" bij Beyond Presence is streaming inference,
"180 ms" bij Anam is agent-responstijd, en geen van beide is spraakeinde tot eerste
mondbeweging.

**Deblokkeert.** De providerkeuze zelf — en het uitwijkpad als de DPA van Beyond Presence
niet aanvaardbaar blijkt.

---

## 6. Anthropic — nog niet nodig

```
ANTHROPIC_API_KEY=
```

Fase 1 gebruikt de echo-agent: hij herhaalt wat de cliënt zei. Dat is opzet. Zit er een
echt model in de lus, dan weet je bij een tegenvallende meting niet of het aan het
transport ligt of aan de generatie.

Nodig vanaf **Fase 2**, en dan via een **EU-regio-endpoint** (Bedrock `eu-central-1` of
Vertex `europe-west4`), niet de globale.

---

## 7. `SUPABASE_DB_URL` — voor de seed

```
SUPABASE_DB_URL=postgresql://postgres.<ref>:<wachtwoord>@<host>:5432/postgres
```

Geen leverancier maar wel een blokkade: `pnpm db:seed` heeft een echte
databaseverbinding nodig. `supabase db push` past alleen migraties toe, en PostgREST
voert geen losse SQL uit — een API-key helpt hier dus niet.

Te vinden in Supabase onder **Project Settings → Database → Connection string → URI**.
Dit is een databasewachtwoord, geen API-key.

---

## Samengevat

| Nodig voor                        | Variabelen                                             |
| --------------------------------- | ------------------------------------------------------ |
| De seed draaien (nu)              | `SUPABASE_DB_URL`                                      |
| De lus over een echte verbinding  | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| Endpointing en jargon meten       | `DEEPGRAM_API_KEY`                                     |
| Synthese en de 50 ms-eis bewijzen | `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID`                |
| Het gezicht, primair              | `BEY_API_KEY`, `BEY_AVATAR_ID`                         |
| Het gezicht, voor de vergelijking | `ANAM_API_KEY`, `ANAM_AVATAR_ID`                       |
| Fase 2, nog niet nu               | `ANTHROPIC_API_KEY` (EU-endpoint)                      |

Twee dingen die geen sleutel zijn maar wel op de kritieke pad staan: **een EU-regio bij
elke leverancier**, en **de DPA bij de avatarvendor**. Dat laatste heeft de langste
doorlooptijd van alles op deze lijst.
