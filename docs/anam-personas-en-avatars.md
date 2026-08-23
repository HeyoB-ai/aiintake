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
