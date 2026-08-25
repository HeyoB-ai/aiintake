# Deploy — Netlify (web) en Railway (worker)

Twee vlakken, twee platformen, en dat is geen smaakkwestie. `apps/web` is de control plane:
korte verzoeken, server actions, RLS. `apps/agent` is de realtime plane: één langlevend
proces per gesprek met open audio- en videoverbindingen en barge-in. Serverless routes hebben
geen persistente sockets, kennen cold starts en executielimieten — daar past de worker
structureel niet in.

## Regio

Railway: **europe-west4 (Amsterdam)**. Supabase staat in `eu-central-1` (Frankfurt); dat
scheelt ongeveer 10 ms ten opzichte van Amsterdam en dat is binnen de ruis van de rest van de
keten. Amsterdam ligt dichter bij de Nederlandse bezoeker, en de bezoeker zit in de latency-
keten die telt (mic → STT → LLM → TTS → avatar → beeld). Frankfurt is een prima tweede keuze
als Amsterdam vol zit.

Wat je hoe dan ook níet moet doen: `us-west1` laten staan. Dat is de Railway-standaard, het
kost ongeveer 150 ms per hop en dat is de helft van het hele TTFT-budget. Ook AVG-technisch is
het geen optie: er lopen transcriptfragmenten over deze verbinding.

## Wat waar staat

### Netlify — apps/web

| Variabele | Waarde | Waarom hier |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | de Supabase-project-URL | publiek |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | mag publiek zijn, geeft op zichzelf geen recht |
| `NEXT_PUBLIC_AGENT_WS_URL` | `wss://<jouw-service>.up.railway.app` | het adres van de worker |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` | **alleen hier** |
| `INTAKE_IP_HASH_PEPPER` | 32+ willekeurige tekens | peper voor de IP-hash van de rate limiter |

`SUPABASE_SECRET_KEY` omzeilt RLS volledig. Hij zit in `apps/web` omdat daar de sessietokens
worden uitgegeven — en nergens anders. Zet hem niet in de Railway-UI, ook niet "even om te
testen".

`INTAKE_IP_HASH_PEPPER` genereer je één keer en bewaar je. Verandert hij, dan hashen alle
adressen anders en begint iedereen met een schone teller — de rate limiter is dan een uur lang
uit. Genereren: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### Railway — apps/agent

| Variabele | Waarde |
|---|---|
| `SUPABASE_URL` | de Supabase-project-URL |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` |
| `ANTHROPIC_API_KEY` | zonder model is er geen gesprek; de worker start niet |
| `DEEPGRAM_API_KEY` | STT |
| `DEEPGRAM_MODEL` | `nova-3` — niet `flux`, dat doet geen Nederlands |
| `CARTESIA_API_KEY`, `CARTESIA_VOICE_ID` | TTS |
| `CARTESIA_MODEL` | `sonic-3` |
| `AVATAR_PROVIDER` | `anam` (of `null` om zonder gezicht te draaien) |
| `ANAM_API_KEY`, `ANAM_PERSONA_ID` | de eigen persona met "Disable LLM" |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | transport |
| `LLM_HOT_MODEL`, `LLM_COLD_MODEL` | standaarden staan in de code |
| `NODE_ENV` | `production` |

`PORT` zet Railway zelf. Niet overschrijven — bindt het proces op iets anders, dan komt er
nooit verkeer binnen en meldt Railway alleen dat de healthcheck faalt.

**De worker weigert met `NODE_ENV=production` te starten** als er een RLS-omzeilende sleutel
in zijn omgeving staat — op naam (`SUPABASE_SECRET_KEY` en de legacy-varianten) én op waarde
(elke variabele die met `sb_secret_` begint, onder welke naam dan ook). Zie
`apps/agent/src/geen-geheime-sleutel.ts`. Dat is de grens uit Fase 0, nu ook gemeten op de
omgeving en niet alleen op de code: de statische test bewijst dat de worker er niet bij kán,
deze controle dat hij hem niet aangereikt krijgt.

Lokaal gooit hij niet maar waarschuwt hij luid. Daar deelt de worker één `.env` met de web-app
en met de testharnas, en daar staat die sleutel dus echt in — hard falen zou betekenen dat het
ontwikkelharnas niet meer start, en dan wordt de controle uitgezet in plaats van de sleutel
weggehaald. De grens die telt is die van de deploy, en daar geldt geen uitzondering.

In productie weigert hij ook `--zonder-token`. Die vlag zet de sessieverificatie uit — nuttig
in het ontwikkelharnas, waar de web-app er niet tussen zit, en rampzalig op internet: dan
start elke verbinding een gesprek dat geld kost.

## Wat via een bestand gaat en wat je klikt

Via de repo (staat er nu in, commit gewoon mee):

- `netlify.toml` — build vanaf de hoofdmap, `pnpm --filter @intake/web build`, publish
  `apps/web/.next`, plus `@netlify/plugin-nextjs`. Zonder die plugin wordt een Next-app als
  statische map gepubliceerd en werken de server actions niet — en de hele intakeroute ís een
  server action.
- `railway.json` — build `pnpm --filter @intake/agent build:worker`, start
  `node apps/agent/dist/worker.js`, healthcheck op `/health`, één replica.

Via de UI: **uitsluitend de env-variabelen en de regio**. Sleutels horen niet in een bestand
dat in git staat.

### Netlify, stap voor stap

1. Add new site → Import an existing project → GitHub → `HeyoB-ai/aiintake`.
2. Build-instellingen: **niets invullen** — `netlify.toml` doet dat. Wijkt de UI af van het
   bestand, dan wint de UI, en dan zoek je later naar een build die anders draait dan hij
   leest.
3. Site configuration → Environment variables → de vijf uit de tabel hierboven.
4. Deploy.

`NEXT_PUBLIC_*` wordt bij het bouwen in de bundel gezet. Zet ze dus vóór de eerste deploy, en
na elke wijziging opnieuw deployen (Deploys → Trigger deploy → **Clear cache and deploy**).
Een gewijzigde `NEXT_PUBLIC_AGENT_WS_URL` zonder nieuwe build verandert niets, en dat kost een
avond.

### Railway, stap voor stap

1. New Project → Deploy from GitHub repo → `HeyoB-ai/aiintake`.
2. Settings → **Region → europe-west4 (Amsterdam)**. Doe dit vóór de eerste deploy; een regio
   wijzigen betekent de service opnieuw aanmaken.
3. Settings → Networking → **Generate Domain**. Dat geeft `<iets>.up.railway.app`.
4. Variables → de tabel hierboven. `PORT` niet.
5. Deploy. Controleer in de logs dat er `avatar: Anam · …` staat en niet `avatar: geen`.
6. Neem het domein over in Netlify als `NEXT_PUBLIC_AGENT_WS_URL=wss://<domein>` — **zonder
   poortnummer**, en deploy Netlify opnieuw.

## TLS: regelt Railway dat zelf?

Ja, voor het gegenereerde domein en voor een eigen domein. Railway zet er een edge voor die
TLS termineert (certificaat via Let's Encrypt, automatisch verlengd) en het verkeer intern
doorzet naar jouw `PORT` over plat HTTP. Je container hoeft dus geen certificaat te hebben en
moet dat ook niet proberen — de `--tls`-vlag uit `pnpm dev:live:https` is er voor het LAN, niet
voor Railway.

Voor de WebSocket betekent dat: `wss://<domein>` **zonder poort**. De edge luistert op 443 en
doet de upgrade door. Een `wss://<domein>:5174` werkt niet; die poort bestaat alleen binnen de
container.

En dit is de reden dat het moet kloppen: de pagina op Netlify staat op `https`, en een
`https`-pagina mag geen `ws://` openen. De browser blokkeert dat als gemengde inhoud, zonder
fout en zonder event — je ziet alleen een gespreksscherm dat blijft laden. Het cliëntscherm
controleert die combinatie sinds kort zelf en weigert met de reden erbij
(`apps/web/src/app/intake/[organizationSlug]/intake-flow.tsx`).

## Eén replica

`numReplicas: 1` in `railway.json`. Niet omdat het niet zou schalen — een WebSocket is één TCP-
verbinding en blijft vanzelf bij één proces — maar omdat elke draaiende replica geld kost en
er nog geen maat is op wat één replica aankan. Schalen pas als er een meting onder ligt.

Let ook op het herstartbeleid: een herstart verbreekt elk lopend gesprek. `ON_FAILURE` met vijf
pogingen is bewust, maar een deploy midden op de dag gooit gesprekken eruit die op dat moment
lopen.

## Wat nog niet klopt

`apps/agent/src/main.ts` is het startpunt uit Fase 0 en luistert nergens op — er staat
letterlijk "wacht op sessies — de realtime-lus volgt in Fase 1". Het startpunt dat wél een
WebSocket serveert is `apps/agent/live/server.ts`, oorspronkelijk het ontwikkelharnas. Daar
wijst `build:worker` nu naar, met de sessieverificatie verplicht en de testpagina eruit
(die geeft 404 in de bundel).

Dat werkt, en het is niet netjes: de productie-worker draait op een bestand dat in een map
`live/` staat en dat nog een `--zonder-token`- en een `--tls`-vlag heeft die daar niets te
zoeken hebben. Het hoort een eigen `src/`-entrypoint te worden met de harnas-specifieke
dingen eruit. Zolang dat niet gebeurd is, staat dit hier zodat niemand denkt dat
`pnpm --filter @intake/agent build` (die `src/main.ts` bundelt) een bruikbare worker oplevert.
