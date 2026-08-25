# Anam — wat er op het account staat

Opgehaald 23 augustus 2026 via `GET /v1/personas`, `/v1/avatars` en `/v1/voices`.

## Persona's (3) — allemaal stock-demo's

| UUID                                   | naam                        | taal   | avatarModel |
| -------------------------------------- | --------------------------- | ------ | ----------- |
| `4314d606-bab4-5fc8-808b-878c43ae6a4c` | Anika - Spanish Barista     | **es** | cara-4      |
| `1526aaba-6f99-51a4-8c80-f0fd32d0f2e0` | Samira - Study Coach        | en     | cara-4      |
| `62b6df6d-24f9-5d35-b310-209c7953465e` | Hana - Sales Representative | en     | cara-4      |

**De eerste stond in `.env` als `ANAM_AVATAR_ID`** — een Spaanse barista met
`languageCode: es`. Dat is geen avatar maar een compleet profiel, inclusief taal en
systeemprompt, en het is niet wat je voor een Nederlandse arbeidsrecht-intake wilt.

## Avatars (10) — alleen het gezicht

| UUID                                   | naam    | variant |
| -------------------------------------- | ------- | ------- |
| `edf6fdcb-acab-44b8-b974-ded72665ee26` | Mia     | studio  |
| `071b0286-4cce-4808-bee2-e642f1062de3` | Liv     | home    |
| `6cc28442-cccd-42a8-b6e4-24b7210a09c5` | Gabriel | table   |
| `27e12daa-50fc-4384-93c2-ebca73f1f78d` | Anne    | home    |
| `dc9aa3e1-32f2-499e-9921-ecabac1076fc` | Bella   | sofa    |
| `8a339c9f-0666-46bd-ab27-e90acd0409dc` | Finn    | lean    |
| `6dbc1e47-7768-403e-878a-94d7fcc3677b` | Sophie  | sofa    |
| `ecfb2ddb-80ec-4526-88a7-299a4738957c` | Hunter  | table   |
| `edcb8f1a-334f-4cdb-871c-5c513db806a7` | Julia   | sofa    |
| `ccf00c0e-7302-455b-ace2-057e0cf58127` | Kevin   | table   |

Alle tien: `renderStyle: realistic`, `activeVersion: cara-4`,
`availableVersions: ["cara-3", "cara-4", "cara-4-latest"]`.

## De modelvraag

**Ja, er is een modelniveau, en het staat op twee plekken.** Op de avatar als
`activeVersion` (met `availableVersions` ernaast) en op de persona als `avatarModel`.
Alles staat op **cara-4**; er is een `cara-4-latest` beschikbaar en er is geen cara-5.

`directorNotes` in hun SDK is gemarkeerd als "Cara 4 avatars only", wat bevestigt dat
cara-4 de huidige generatie is.

**Niet vastgesteld:** of `cara-4-latest` per sessie te kiezen is. De token-API accepteerde
een veld `avatarVersion`, maar deze API accepteert álles — een 200 zegt hier niets. Het
lijkt een eigenschap van de avatar (`activeVersion`) en dus iets voor het dashboard of een
PATCH. Ik heb niets aan het account gewijzigd.

## CORRECTIE (23 augustus 2026) — de persona is de enige knop

Hierboven stond dat een eigen avatar "de volledige configuratie" vraagt: personaId,
avatarId en voiceId samen. **Dat was een verkeerde diagnose.** De juiste is: hun API
negeert `avatarId` en `voiceId` in `personaConfig` zodra er een `personaId` bij staat.

Gemeten: `personaConfig: { personaId: <Anika>, avatarId: <Mia>, voiceId: <…> }` geeft
HTTP 200 en levert **Anika** in beeld, in het Spaans. Het gezicht, de stem, de taal, de
systeemprompt én de LLM komen alle vijf van de persona.

Dat verklaarde twee klachten tegelijk die als los werden gemeld:

- het gezicht bleef Anika terwijl `ANAM_AVATAR_ID` op Mia stond;
- bij elke sessiestart klonk een kort Spaans fragment in een andere stem.

Het tweede is de ernstigere. Anika's persona heeft een echte `llmId`, dus hún engine
begroet de cliënt uit zichzelf. Gemeten met `pnpm --filter @intake/agent diag:stilte`:
piek-RMS 0,506 op 1276 ms, met `role: "persona"` en de tekst `¡`, `Hola! `, `Bienvenido`.
Twee stemmen in een intakegesprek is een productfout, geen schoonheidsfoutje.

Dit is dezelfde klasse als de Flux-claim in ADR-0009: een bewering die klopte met de
symptomen en niet met de oorzaak. De aanleiding is ook dezelfde — hun API antwoordt 200 op
velden die hij daarna weggooit, dus een geslaagde call bewijst niets.

## De oplossing: een eigen persona met de LLM uit

`GET /v1/llms` bevat een ingang die precies hiervoor bestaat:

```
id          CUSTOMER_CLIENT_V1
displayName Disable LLM
llmFormat   none
isGlobal    true
```

Een eigen persona met dat `llmId` houdt hun engine stil en laat onze audio door. Beide
kanten gemeten in één sessie:

| meting                              | Anika (stock)       | Legal Intake NL (eigen) |
| ----------------------------------- | ------------------- | ----------------------- |
| piek-RMS zonder dat wij iets sturen | 0,506               | **0**                   |
| piek-RMS na onze eigen toon         | n.v.t.              | 0,197                   |
| id-voorvoegsel van de uiting        | `persona::engine::` | `persona::external::`   |

Dat laatste voorvoegsel is een gratis controle: `engine` betekent dat hun brein sprak.

Aanmaken is geautomatiseerd en idempotent:

```
pnpm --filter @intake/agent anam:persona    # maakt of vindt "Legal Intake NL"
pnpm --filter @intake/agent diag:stilte     # bewijst dat hij zwijgt én onze audio doorlaat
```

**Niet zetbaar via de API:** `enableAudioPassthrough` komt altijd als `false` terug, ook na
`POST` met `true` en na een `PUT` die 200 geeft (`PATCH` geeft 405). Het blijkt er ook niet
toe te doen: met `llmId: CUSTOMER_CLIENT_V1` komt onze audio door terwijl die vlag `false`
staat. Waar dat veld dan wél voor is, is een vraag voor hun support.

De liveserver controleert bij elke start of de persona nog `CUSTOMER_CLIENT_V1` draagt en
weigert anders te starten. Dat is een instelling die in hún dashboard te wijzigen is, dus
een controle bij het inrichten zou niet genoeg zijn.

## Wat te zetten in `.env`

```
ANAM_PERSONA_ID=59218393-f2c0-4509-b28a-c70af3e46125   # "Legal Intake NL", gezicht Mia, LLM uit
ANAM_AVATAR_ID=edf6fdcb-acab-44b8-b974-ded72665ee26    # alleen het voorkeursgezicht voor anam:persona
```

`ANAM_VOICE_ID` is niet meer nodig: de sessie kijkt alleen naar `ANAM_PERSONA_ID`.

## Sessies beëindigen — en wat het kost als je het niet doet

Avatarminuten lopen zolang **Anam** de sessie open heeft staan, niet zolang wij hem
gebruiken. Dat verschil is meetbaar en het is geld.

**`GET /v1/sessions`** geeft per sessie `startTime`, `endTime`, `sessionLengthMs` en
`exitStatus`. Een lege `endTime` betekent: de teller loopt. Dit is de enige eerlijke
controle — "onze kant heeft losgelaten" zegt er niets over.

**`POST /v1/sessions/{id}/stop`** beëindigt een lopende sessie en geeft 200. Dit is de
knop. Niet te verwarren met `DELETE /v1/sessions/{id}`: die verwijdert de gegevens en geeft
409 zolang de sessie loopt.

**Wat er gebeurt als je niets doet.** Een tab die hard wordt weggeklikt blijft gemeten
**10 tot 20 seconden** doorlopen voordat hun engine hem opruimt. Bij een middag ontwikkelen
met tientallen herstarts telt dat op, en het verklaart de "Concurrency limit reached" die
we eerder zagen bij metingen die kort na elkaar draaiden.

**Hoe het nu is geregeld.** De browser geeft `getActiveSessionId()` door aan de server; de
server bedient de knop. Drie wegen naar buiten, alle drie geverifieerd tegen hun API met
`pnpm --filter @intake/agent diag:afsluiten`:

| weg                                 | sessie dicht na |
| ----------------------------------- | --------------- |
| tab weggeklikt                      | 747 ms          |
| server stopt (ctrl-c)               | 665 ms          |
| 90 s zonder spraak (getest op 10 s) | binnen de klok  |

De server doet dit en niet de browser, omdat een afgebroken pagina geen asynchroon werk
meer afmaakt. De browser ruimt óók op via `pagehide`, maar als vangnet.

**Correctie (23 augustus, na de eerste echte test).** De inactiviteitsklok begon te lopen
zodra de WebSocket openging. Dat is te vroeg op twee manieren: de keten staat er dan nog
niet, en de cliënt heeft nog niets kúnnen zeggen. De regel is nu:

1. geen klok zolang het gesprek niet begonnen is (met avatar: ná het eerste frame);
2. daarna 30 s respijt waarin hij helemaal niet loopt — de openingsbeurt duurt al zo'n
   vijftien seconden en daarna hoort iemand te kunnen nadenken;
3. pas dan telt de limiet van 90 s, vanaf het laatste van (einde respijt, laatste spraak).

De beslissing staat als losse functie in `apps/agent/src/inactiviteit.ts` met zeven tests.
Dat is bewust: als regel de liveserver in verweven zat, was hij alleen te toetsen door een
hele sessie op te zetten met STT, TTS en avatar erbij — en toen Cartesia's tegoed op was,
was hij daarmee helemaal niet meer te toetsen.

**Elke afsluiting logt nu zijn route** — `tab`, `server`, `klok` of `stopknop` — met de
WebSocket-sluitcode erbij. Dat log wees de echte oorzaak aan van de sessie die meteen
dichtviel: niet de afsluitlogica, maar `startEchoSession` die gooide omdat Cartesia HTTP
402 gaf (tegoed op). De server sloot de socket daarna correct; hij logde alleen niets, en
in de pagina werd de foutmelding overschreven door de statusregel van het sluiten. Beide
gerepareerd: de fout wordt serverzijdig gelogd en blijft in de pagina staan.

**Wat niet getoetst is:** dat `process.on('SIGINT')` daadwerkelijk afgaat. Windows levert
console-signalen niet programmatisch af — `kill('SIGINT')` op een node-kindproces roept de
handler niet aan, gemeten. De controle gebruikt daarom een stdin-ingang die exact dezelfde
`stopAlles()` aanroept. Wat er dus openstaat is één regel bedrading, niet de routine.

**Valkuil in het harnas.** Chromes `--use-fake-device-for-media-stream` zendt een continue
pieptoon uit. Die komt door de ruispoort, telt als spraak, en houdt de inactiviteitsklok
eeuwig tegen — de test zat zelf te praten en meldde "de klok loopt niet". Opgelost met
`--use-file-for-fake-audio-capture` en een wav met digitale stilte.

## Hoe het er eerder stond (achterhaald)

## Een eigen avatar kiezen vraagt de volledige configuratie

Hun `CustomPersonaConfig` eist **personaId, name, avatarId én voiceId samen**. Een config
met alleen een `avatarId` levert een token op dat de API met 200 accepteert maar dat de
signalling daarna weigert:

```
WebSocket connection to wss://connect-eu.anam.ai/... failed:
HTTP Authentication failed; no valid credentials available
```

Dezelfde klasse fout als `personaConfig.id` destijds: de melding valt in de browser, ver
van de plek waar hij gemaakt is. De adapter gooit nu vooraf met een uitleg.

## Stemmen (10)

Geen enkele stem draagt een taalveld — alleen `country`, `gender` en `displayTags`. Er is
dus geen aantoonbaar Nederlandse stem. Voor ons maakt dat niet uit: bij passthrough leveren
wij de audio en wordt hun stem niet gebruikt. Hij moet er alleen zijn omdat de configuratie
hem eist.

## Wat te zetten in `.env`

```
ANAM_AVATAR_ID=edf6fdcb-acab-44b8-b974-ded72665ee26   # Mia, of een andere uit de lijst
ANAM_PERSONA_ID=4314d606-bab4-5fc8-808b-878c43ae6a4c  # verplicht, ook bij een eigen avatar
ANAM_VOICE_ID=91b4ce0f-4fc0-11f1-84b0-52bacf74fa75    # verplicht, wordt niet gebruikt
```

Geverifieerd met Mia: video 1152×768, beurt compleet, geen console- of paginafouten.

De liveserver probeert deze configuratie nu **bij het opstarten** uit door één sessietoken
te vragen, en weigert te starten als dat niet lukt. Daarvoor faalde het pas bij de eerste
bezoeker: de server drukte "avatar: Anam" af, de pagina kreeg geen token en viel stil terug
op geen-gezicht. Wat de server meldt klopt nu op het moment dat hij het meldt.

De pagina beslist bovendien op `ready.avatar` en niet meer op de aanwezigheid van een
token, zodat "het token is mislukt" zichtbaar iets anders is dan "er was geen gezicht
bedoeld".
