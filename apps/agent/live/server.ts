import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { NullAvatarProvider } from '@intake/provider-avatar';
import type {
  AvatarCapabilities,
  AvatarEvents,
  AvatarProvider,
  AvatarSession,
  AvatarSessionOptions,
  TrackHandle,
} from '@intake/provider-avatar';
import { AnthropicLlmProvider } from '@intake/provider-llm';
import { AnamAvatarProvider, type AnamPersona } from '../src/avatar/anam';
import type { OrgConfig } from '@intake/domain';
import { IntakeSession } from '../src/intake-session';
import { mediaConfigFrom, startEchoSession } from '../src/echo-session';
import { formatHudLine } from '../src/metrics';
import type { AgentEnv } from '../src/env';
import { magAfsluitenWegensStilte } from '../src/inactiviteit';
import { assertGeenGeheimeSleutel } from '../src/geen-geheime-sleutel';

/**
 * Zelf tegen de intake praten, lokaal.
 *
 * Geen gezicht, geen LiveKit, geen database. Microfoon in de browser, dezelfde
 * mediaketen als in productie — Deepgram, de engine, Cartesia — en het geluid komt terug
 * over dezelfde WebSocket. De null-avatarprovider houdt de afspeelklok bij, zodat
 * barge-in en de transcripttruncatie zich gedragen zoals ze in productie doen.
 *
 * Bewust dezelfde `startEchoSession` als de echo-agent, met een andere `respond`. Twee
 * bedradingen zou betekenen dat de barge-in hier subtiel anders werkt dan daar, en dan
 * bewijst luisteren naar deze pagina niets over het product.
 *
 * Draaien met: pnpm dev:live
 */

const HIER = dirname(fileURLToPath(import.meta.url));
/*
 * De poort.
 *
 * `PORT` eerst: dat is de variabele die Railway (en elke andere containerhost) injecteert,
 * en die kun je niet zelf kiezen. Bindt het proces op iets anders, dan komt er nooit verkeer
 * binnen en meldt de host alleen dat de healthcheck faalt.
 */
const POORT = Number(process.env['PORT'] ?? process.env['LIVE_PORT'] ?? 5174);
const PRODUCTIE = process.env['NODE_ENV'] === 'production';

/*
 * In productie is `--zonder-token` verboden.
 *
 * Die vlag zet de sessieverificatie uit — bedoeld voor het ontwikkelharnas, waar de
 * web-app er niet tussen zit. Blijft hij per ongeluk in het startcommando staan, dan is de
 * WebSocket voor iedereen op internet open en start elke verbinding een gesprek dat geld
 * kost. Dat is geen degradatie die je later opmerkt; dat is de rekening van volgende maand.
 */
if (PRODUCTIE && process.argv.includes('--zonder-token')) {
  console.error(
    '\n  --zonder-token is verboden met NODE_ENV=production.\n' +
      '  Die vlag zet de sessieverificatie uit; de socket zou voor iedereen open staan.\n',
  );
  process.exit(1);
}
const SAMPLE_RATE = 16_000;

/**
 * Rechtstreeks uit process.env, en niet via `readAgentEnv()`.
 *
 * Die leest de volledige agent-omgeving en eist onder meer de Supabase-variabelen. Deze
 * pagina praat niet met de database, dus hij hoort niet om te vallen als die configuratie
 * ontbreekt — dezelfde redenering als bij `mediaConfigFrom`, en de reden dat die functie
 * een `Partial` accepteert.
 */
/*
 * De grens uit Fase 0, gecontroleerd voordat er iets anders gebeurt.
 *
 * Deze server leest process.env rechtstreeks en komt dus niet langs readAgentEnv(), waar
 * dezelfde controle staat. Dat is precies het gat: dit bestand is óók het startpunt op
 * Railway, en daar komt de omgeving uit een UI waarin iemand "alle sleutels" kan plakken.
 */
assertGeenGeheimeSleutel();

const env = process.env as Partial<AgentEnv>;
const media = mediaConfigFrom(env);

if (!env.ANTHROPIC_API_KEY) {
  console.error(
    '\nANTHROPIC_API_KEY ontbreekt. Zonder model is er geen gesprek, alleen een echo.\n',
  );
  process.exit(1);
}

/**
 * Met of zonder gezicht.
 *
 * Sluit aan op de bestaande `AVATAR_PROVIDER` uit .env: `null` is geen gezicht — de
 * browser speelt onze TTS dan rechtstreeks af, wat geen avatarminuten kost — en `anam`
 * zet het pratende gezicht aan.
 *
 * Dit is geen providerkeuze. Bey blijft de tegenhanger in de bakeoff zodra hun support
 * reageert; dit is er om te horen en te zien hoe het gesprek voelt mét beeld.
 */
const AVATAR = process.env['AVATAR_PROVIDER'] ?? 'null';

/**
 * Hoe lang stilte mag duren voordat de sessie sluit.
 *
 * Instelbaar omdat de controle in bakeoff/afsluiten-diagnose.ts hem anders 90 seconden
 * lang zou moeten uitzitten — en een test die zo lang duurt, draait niemand.
 */
const INACTIVITEIT_MS = Number(process.env['INACTIVITEIT_MS'] ?? 90_000);

/**
 * Hoe lang na de start de klok helemaal niet loopt.
 *
 * De openingsbeurt duurt al zo'n vijftien seconden, en daarna hoort iemand te kunnen
 * nadenken voordat hij antwoordt. De regel zelf staat in src/inactiviteit.ts, met tests.
 */
const RESPIJT_MS = Number(process.env['RESPIJT_MS'] ?? 30_000);

/**
 * Alle lopende verbindingen, zodat ctrl-c ze allemaal netjes kan afsluiten.
 *
 * Zonder dit blijft er bij elke serverherstart een avatarsessie achter die pas na tien tot
 * twintig seconden door hun engine wordt opgeruimd.
 */
const openVerbindingen = new Set<(reden: string) => Promise<void>>();

/**
 * Zit er spraak in dit blokje audio?
 *
 * Alleen om de inactiviteitsklok te voeden, niet om beurten te bepalen — dat doet de STT.
 * De drempel is bewust ruim: iemand die zachtjes praat hoort de sessie open te houden, en
 * een valse "er is spraak" kost hooguit dat de teller iets later afgaat. Andersom zou een
 * gemist woord de sessie midden in een gesprek afkappen, en dat is veel erger.
 */
function isSpraak(pcm: Int16Array): boolean {
  if (pcm.length === 0) return false;
  let som = 0;
  for (let i = 0; i < pcm.length; i += 1) som += (pcm[i] as number) * (pcm[i] as number);
  return Math.sqrt(som / pcm.length) / 32768 > 0.005;
}

const ORG: OrgConfig = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Kantoor De Vries',
  slug: 'devries',
} as OrgConfig;

/**
 * De avatar die naar de browser praat.
 *
 * Hij delegeert alles aan de null-provider — inclusief de afspeelklok waarop `spokenMs`
 * en dus de transcripttruncatie rusten — en stuurt de audio bovendien de WebSocket in.
 * Zo hoor je precies wat de boekhouding denkt dat je hoort.
 */
function browserAvatar(inner: AvatarProvider, ws: WebSocket): AvatarProvider {
  return {
    id: inner.id,
    capabilities: inner.capabilities as AvatarCapabilities,
    async createSession(options: AvatarSessionOptions): Promise<AvatarSession> {
      const s = await inner.createSession(options);
      return {
        async pushAudio(pcm: Int16Array, seq: number) {
          if (ws.readyState === ws.OPEN) {
            ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          }
          await s.pushAudio(pcm, seq);
        },
        async interrupt() {
          // De browser moet zijn wachtrij weggooien, anders praat hij door nadat de
          // server allang is gestopt — en dan lijkt barge-in kapot terwijl hij werkt.
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'clear' }));
          return s.interrupt();
        },
        endTurn: () => {
          // De browser moet weten wanneer een beurt af is: met een avatar sluit hij dan
          // de audiostroom naar hun SDK, en zonder avatar is het een no-op.
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'endturn' }));
          s.endTurn();
        },
        videoTrack: () => s.videoTrack() as Promise<TrackHandle>,
        on: <E extends keyof AvatarEvents>(e: E, h: AvatarEvents[E]) => s.on(e, h),
        disconnect: () => s.disconnect(),
      };
    },
  };
}

let avatarPersona: AnamPersona | null = null;

/**
 * De avatarconfiguratie meteen uitproberen, niet pas bij de eerste verbinding.
 *
 * Anders drukt de server "avatar: Anam" af terwijl het token per verbinding faalt, valt de
 * pagina stilzwijgend terug op geen-gezicht, en zoek je het in de frontend. Wat de server
 * meldt hoort te kloppen op het moment dat hij het meldt.
 */
async function controleerAvatar(): Promise<AnamAvatarProvider | null> {
  if (AVATAR !== 'anam') return null;

  const provider = new AnamAvatarProvider({
    apiKey: process.env['ANAM_API_KEY'] ?? '',
    personaId: process.env['ANAM_PERSONA_ID'] ?? '',
  });
  // Eerst: praat hun engine zelf mee? Dat is niet aan het token te zien en pas in het
  // gesprek te horen, als tweede stem. Daarna pas het token, want dat kost een sessie.
  avatarPersona = await provider.assertStilBijPassthrough();
  await provider.issueSessionToken();
  return provider;
}

let avatarProviderVoorSessies: AnamAvatarProvider | null = null;
try {
  avatarProviderVoorSessies = await controleerAvatar();
} catch (error) {
  console.error('\n  AVATAR_PROVIDER=anam, maar de avatar kan niet worden opgezet:\n');
  console.error(`  ${String(error).replace(/^Error: /, '')}\n`);
  console.error('  Zie docs/anam-personas-en-avatars.md voor de UUIDs die op dit account');
  console.error('  staan. Of zet AVATAR_PROVIDER=null om zonder gezicht te draaien.\n');
  process.exit(1);
}

/*
 * De testpagina, als hij er is.
 *
 * Bij het ontwikkelharnas ligt page.html naast dit bestand. In een gebundelde productie-
 * build ligt hij daar niet, en dat hoort ook niet: de cliënt komt daar via apps/web binnen,
 * niet via deze pagina. Een ontbrekend bestand is daar dus de normale toestand en geen fout
 * — vandaar de lege string in plaats van een crash bij het opstarten.
 */
const html = ((): string => {
  try {
    return readFileSync(join(HIER, 'page.html'), 'utf8');
  } catch {
    return '';
  }
})();
/**
 * Stempel waaraan te zien is of de pagina van déze serverstart komt.
 *
 * In lokale tijd met de zone erbij. Dit stond eerst in UTC, en dan kost een klokverschil
 * van twee uur een avond zoeken naar een cacheprobleem dat er niet is.
 */
const gestartOp = new Date().toLocaleTimeString('nl-NL', { timeZoneName: 'short' });
/*
 * TLS wanneer `--tls` meekomt.
 *
 * Een `https`-pagina mag geen `ws://` openen: dat is gemengde inhoud, en de browser
 * blokkeert het zonder zichtbare melding — je ziet alleen dat er nooit een gesprek begint.
 * Om vanaf een echt toestel te kunnen testen moet de pagina op HTTPS staan (anders geen
 * microfoon), en dus moet deze socket op WSS.
 *
 * Hetzelfde certificaat als de webapp, zodat er op de telefoon maar één CA te vertrouwen
 * is. Zie `pnpm cert:lan`.
 */
const METTLS = process.argv.includes('--tls');

function maakServer(afhandelaar: Parameters<typeof createServer>[0]) {
  if (!METTLS) return createServer(afhandelaar);

  const map = join(HIER, '..', '..', '..', '.certs');
  try {
    return createTlsServer(
      {
        key: readFileSync(join(map, 'lan-key.pem')),
        cert: readFileSync(join(map, 'lan.pem')),
      },
      afhandelaar,
    );
  } catch {
    console.error('\n  --tls gevraagd maar .certs/lan.pem ontbreekt. Draai eerst: pnpm cert:lan\n');
    process.exit(1);
  }
}

const server = maakServer((req, res) => {
  if ((req.url ?? '/').startsWith('/health')) {
    res.writeHead(200).end('ok');
    return;
  }
  // Zonder testpagina is er hier niets te halen. In productie is dat de bedoeling: de
  // cliënt komt via apps/web binnen en deze poort draagt alleen de WebSocket.
  if (html === '') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('geen pagina hier');
    return;
  }
  // Niet cachen.
  //
  // Deze pagina verandert bij elke iteratie, en een browser die hem vasthoudt draait
  // stilletjes oude code. Dat is geen theoretisch risico: een oude versie zonder
  // video-element speelt de audio gewoon lokaal af, dus je hóórt een gesprek en ziet
  // geen gezicht — precies het symptoom waarvoor je de frontend gaat zitten uitpluizen.
  res
    .writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    })
    .end(html.replace('__BUILD__', String(gestartOp)));
});

const wss = new WebSocketServer({ server });

/**
 * Eén stukgelopen verbinding mag de server niet meenemen.
 *
 * `wss.on('connection', async …)` geeft een promise die niemand aanpakt: gooit de handler,
 * dan is het een unhandled rejection en valt het hele proces om. Dat gebeurde, en het
 * kostte een meting die op een lege pagina uitkwam terwijl de oorzaak in de server zat.
 * Zelfde klasse als `onTurnError` destijds.
 */
wss.on('connection', (ws, verzoek) => {
  void verbinding(ws, verzoek.url ?? '/').catch((error) => {
    console.error('  verbinding mislukt:', String(error).slice(0, 300));
    try {
      ws.send(JSON.stringify({ type: 'error', waar: 'verbinding', wat: String(error) }));
      ws.close();
    } catch {
      /* de socket was al weg */
    }
  });
});

/**
 * Mag deze verbinding er zijn?
 *
 * De WebSocket accepteerde elke verbinding. Als ontwikkelharnas was dat te verdedigen;
 * zodra de echte cliëntpagina erop aansluit is het een open deur naar een dienst die per
 * seconde geld kost — avatarminuten, STT, TTS en een model.
 *
 * De cliëntpagina krijgt een kortlevend sessietoken van apps/web en stuurt het mee in de
 * URL. Hier wordt het gecontroleerd via `agent_verify_session`, die niets schrijft: op dit
 * moment is er nog geen beurt en geen metriek, en een geweigerde verbinding hoort geen
 * spoor achter te laten.
 *
 * `--zonder-token` zet de controle uit. Dat staat in het script van `pnpm dev:live` en
 * nergens anders: zichtbaar in het commando dat je typt, niet als stille standaard in de
 * server. Een vlag en geen omgevingsvariabele, omdat een variabele op Windows niet
 * portabel voor één commando te zetten is en dan in .env belandt — waar hij ook voor de
 * echte server zou gelden.
 */
/**
 * De eigen namen eerst, de NEXT_PUBLIC_-namen als terugval.
 *
 * Lokaal deelt dit harnas één .env met de web-app, en daar heten ze NEXT_PUBLIC_*. Op
 * Railway staat de web-app er niet en volgt iemand apps/agent/.env.example, waar
 * SUPABASE_URL en SUPABASE_PUBLISHABLE_KEY staan. Las dit alleen de NEXT_PUBLIC_-namen,
 * dan weigert de worker daar elke verbinding met "de worker kan niet verifiëren" — een
 * melding die naar het sessietoken wijst terwijl het de configuratie is.
 */
function supabaseBereik(): { url: string; anon: string } | null {
  const url = process.env['SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const anon =
    process.env['SUPABASE_PUBLISHABLE_KEY'] ?? process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'];
  return url && anon ? { url, anon } : null;
}

/** Het sessietoken en de intake uit de verbindings-URL, zodra de sessie geldig bleek. */
export interface Sessiebewijs {
  readonly token: string;
  readonly intakeId: string;
}

type Toegang = { ok: true; bewijs: Sessiebewijs | null } | { ok: false; reden: string };

async function magVerbinden(url: string): Promise<Toegang> {
  // Zonder verificatie is er ook geen sessie om af te sluiten; het harnas draait dan
  // buiten de database om.
  if (process.argv.includes('--zonder-token')) return { ok: true, bewijs: null };

  const params = new URL(url, 'http://x').searchParams;
  const token = params.get('token');
  const intake = params.get('intake');
  if (!token || !intake) return { ok: false, reden: 'geen sessietoken meegegeven' };

  const bereik = supabaseBereik();
  if (!bereik) return { ok: false, reden: 'de worker kan niet verifiëren' };

  try {
    const res = await fetch(`${bereik.url}/rest/v1/rpc/agent_verify_session`, {
      method: 'POST',
      headers: {
        apikey: bereik.anon,
        Authorization: `Bearer ${bereik.anon}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_session_token: token, p_intake_id: intake }),
    });
    if (!res.ok) return { ok: false, reden: 'sessietoken geweigerd' };
    const rijen = (await res.json()) as unknown[];
    if (!Array.isArray(rijen) || rijen.length === 0) {
      return { ok: false, reden: 'sessietoken geweigerd' };
    }
    return { ok: true, bewijs: { token, intakeId: intake } };
  } catch {
    return { ok: false, reden: 'de verificatie kon niet worden uitgevoerd' };
  }
}

/**
 * De sessie afsluiten in de database.
 *
 * ## Waarom dit hier moest komen
 *
 * `agent_end_session` bestond al, en `AgentRpc.endSession` in @intake/db-core roept hem
 * netjes aan — maar die code hangt aan `src/main.ts`, en dat bestand luistert nergens op.
 * De worker die in productie draait is dit bestand, oorspronkelijk het ontwikkelharnas, en
 * dat had nooit een databasekant. Gevolg: `ended_at` werd nooit geschreven. Niet één pad
 * dat brak, maar een pad dat er niet was. Zie docs/deploy.md, "Wat nog niet klopt".
 *
 * Het effect was niet cosmetisch. De functie die sessies uitgeeft telt de gelijktijdige
 * sessies als `ended_at is null`, dus elk afgerond gesprek bleef meetellen tot
 * `maxConcurrentSessions` vol zat en niemand meer kon beginnen.
 *
 * Die functie wordt hier bewust niet bij naam genoemd: de statische grenscontrole in
 * packages/db verbiedt dat woord in apps/agent, en terecht — de worker hoort zijn eigen
 * credential niet te kunnen aanmaken. Dat het verbod ook op commentaar slaat, is geen
 * scherpte die eraf moet: een grep die uitzonderingen kent, bewaakt niets meer.
 *
 * ## De vertaling van route naar reden
 *
 * `end_reason` kent vijf waarden: completed, client_left, timeout, error, budget. De vier
 * routes hier passen daar niet één-op-één op, en dat is beter zichtbaar dan weggemoffeld:
 * 'server' is een herstart of deploy en dus geen fout van het gesprek, maar er is geen
 * betere emmer. Wie hierop rapporteert moet dat weten.
 *
 * ## Waarom de seconden de socketduur zijn
 *
 * Niet de spreektijd, en ook niet de avatarminuten. Dit is wat deze worker kan meten
 * zonder aan te nemen: van open tot dicht. Bij een sessie die nooit verder kwam dan het
 * toestemmingsscherm staat er dus een kort getal, en dat klopt.
 */
async function schrijfSessieEinde(
  bewijs: Sessiebewijs,
  reden: 'completed' | 'client_left' | 'timeout' | 'error',
  secondenOpen: number,
): Promise<void> {
  const bereik = supabaseBereik();
  if (!bereik) return;

  try {
    const res = await fetch(`${bereik.url}/rest/v1/rpc/agent_end_session`, {
      method: 'POST',
      headers: {
        apikey: bereik.anon,
        Authorization: `Bearer ${bereik.anon}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_session_token: bewijs.token,
        p_intake_id: bewijs.intakeId,
        p_end_reason: reden,
        p_billed_seconds: secondenOpen,
      }),
    });
    if (!res.ok) {
      // Luid loggen en niet gooien: het afsluiten van de avatarsessie en de socket mag
      // hier niet van afhangen. Maar stil blijven zou betekenen dat een rij op null blijft
      // staan zonder dat iemand het weet, en dat is precies hoe dit is ontstaan.
      console.log(`    ended_at NIET geschreven: HTTP ${res.status} ${await res.text()}`);
    }
  } catch (fout) {
    console.log(`    ended_at NIET geschreven: ${String(fout)}`);
  }
}

async function verbinding(ws: WebSocket, verzoekUrl: string) {
  const geopendOp = Date.now();
  const toegang = await magVerbinden(verzoekUrl);
  if (!toegang.ok) {
    console.log(`  verbinding geweigerd: ${toegang.reden}`);
    // Sluiten met een reden, niet stil laten hangen: een cliënt die niets hoort, wacht.
    try {
      ws.send(JSON.stringify({ type: 'error', waar: 'toegang', wat: toegang.reden }));
      ws.close(4401, 'geen geldige sessie');
    } catch {
      /* de socket was al weg */
    }
    return;
  }

  const stuur = (bericht: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(bericht));
  };

  const llm = new AnthropicLlmProvider({ apiKey: env.ANTHROPIC_API_KEY! });
  const intake = new IntakeSession({
    llm,
    organization: ORG,
    hotModel: env.LLM_HOT_MODEL ?? 'claude-haiku-4-5-20251001',
    coldModel: env.LLM_COLD_MODEL ?? 'claude-haiku-4-5-20251001',
  });

  let sessie: Awaited<ReturnType<typeof startEchoSession>> | null = null;
  let wilStarten = false;

  /*
   * Het afsluiten van de avatarsessie, en waarom de server dat doet.
   *
   * Avatarminuten lopen door zolang Anam de sessie open heeft staan, niet zolang wij hem
   * gebruiken. Een weggeklikte tab blijft gemeten 10 tot 20 seconden staan voordat hun
   * engine hem opruimt; dat zijn betaalde minuten voor een gesprek dat niemand voert.
   *
   * De browser kan het zelf via `stopStreaming()`, maar een pagina die wordt afgebroken
   * krijgt geen kans meer om asynchroon werk af te maken. De server heeft dat probleem
   * niet: hij ziet de socket dichtgaan. Vandaar dat de browser zijn sessie-id doorgeeft
   * en de server de knop bedient — `POST /v1/sessions/{id}/stop`.
   */
  let anamSessionId: string | null = null;
  let afgesloten = false;

  /** Waar een afsluiting vandaan kwam. Vier routes, en ze horen uit elkaar te houden zijn. */
  type Route = 'tab' | 'server' | 'klok' | 'stopknop';
  const routeTekst: Record<Route, string> = {
    tab: 'tab weg / socket dicht',
    server: 'server stopt',
    klok: 'inactiviteitsklok',
    stopknop: 'Stop-knop in de pagina',
  };

  /** Zie schrijfSessieEinde: vier routes op vier van de vijf toegestane redenen. */
  const routeReden = {
    tab: 'client_left',
    server: 'error',
    klok: 'timeout',
    stopknop: 'completed',
  } as const;

  async function beeindig(route: Route, detail = ''): Promise<void> {
    if (afgesloten) return;
    afgesloten = true;

    const reden = routeTekst[route] + (detail ? ` — ${detail}` : '');

    /*
     * Altijd loggen, ook zonder avatarsessie.
     *
     * Dit stond eerst binnen de `if (anamSessionId)` hieronder. Sloot de verbinding
     * vóórdat het eerste frame er was, dan was er geen id, en dan stond er niets in het
     * log — je zag alleen het gevolg in de browser en moest raden welke van de vier
     * routes het was. Precies de situatie waarin je dit log het hardst nodig hebt.
     */
    console.log(
      `  afsluiten via ${route}: ${reden}` +
        (anamSessionId ? ` · avatarsessie ${anamSessionId.slice(0, 8)}` : ' · geen avatarsessie'),
    );

    // De browser laten weten waaróm, want anders staat er een dood beeld zonder uitleg.
    // Dit mag falen; de sessie sluiten mag daar niet van afhangen.
    stuur({ type: 'stop', reden });

    /*
     * Eerst de database, dan de rest.
     *
     * Niet omdat het dringender is, maar omdat het token na `agent_end_session` wordt
     * ingetrokken en er daarna dus niets meer te schrijven valt. Zou dit onderaan staan en
     * er ging iets mis bij het sluiten van de avatarsessie, dan bleef `ended_at` op null —
     * en precies dát is het gedrag dat de dienst platlegde.
     */
    if (toegang.ok && toegang.bewijs) {
      await schrijfSessieEinde(
        toegang.bewijs,
        routeReden[route],
        Math.round((Date.now() - geopendOp) / 1000),
      );
    }

    if (anamSessionId && avatarProviderVoorSessies) {
      const ok = await avatarProviderVoorSessies.stopSession(anamSessionId);
      if (!ok) console.log('    hun API bevestigde het stoppen niet');
    }
    await sessie?.close();
    if (ws.readyState === ws.OPEN) ws.close();
  }

  openVerbindingen.add((detail) => beeindig('server', detail));

  /*
   * De inactiviteitsklok.
   *
   * Negentig seconden zonder spraak van de cliënt: dan is het gesprek voorbij, of de
   * pagina staat vergeten open. In beide gevallen hoort de teller te stoppen.
   *
   * Gemeten op de binnenkomende audio en niet op afgeronde beurten: iemand die begint te
   * praten maar wiens uitspraak nooit een beurt wordt, is wél aanwezig. Andersom telt een
   * antwoord van de assistent ook mee, want tijdens een lang antwoord is de cliënt stil
   * zonder dat de sessie dood is.
   */
  let gesprekBegonOp: number | null = null;
  let laatsteActiviteitOp: number | null = null;
  const raakteActief = (): void => {
    laatsteActiviteitOp = performance.now();
  };
  const klok = setInterval(() => {
    const stand = {
      nu: performance.now(),
      gesprekBegonOp,
      laatsteActiviteitOp,
      limietMs: INACTIVITEIT_MS,
      respijtMs: RESPIJT_MS,
    };
    if (!magAfsluitenWegensStilte(stand)) return;
    void beeindig(
      'klok',
      `${Math.round(INACTIVITEIT_MS / 1000)} s stil, na ${Math.round(RESPIJT_MS / 1000)} s respijt`,
    );
  }, 2_000);
  ws.on('close', () => clearInterval(klok));

  /**
   * De handlers vóór het opzetten van de sessie registreren.
   *
   * De browser stuurt `start` zodra de socket open is, en dat is honderden milliseconden
   * eerder dan het moment waarop Deepgram, Cartesia en de avatar er staan. Werd de
   * handler pas daarna gezet, dan verdween dat bericht en bleef het stil — zonder fout,
   * wat de vervelendste variant is.
   */
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!sessie) return; // audio van vóór de sessie heeft geen bestemming
      const buf = data as Buffer;
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      if (isSpraak(pcm)) raakteActief();
      sessie.pushAudio(pcm);
      return;
    }
    try {
      const bericht = JSON.parse(String(data)) as { type?: string; sessionId?: string };
      if (bericht.type === 'anam' && bericht.sessionId) {
        // Vanaf hier kan de server de sessie zelf beëindigen. Daarvóór niet, en dat is de
        // reden dat de browser dit meteen na het verbinden stuurt.
        anamSessionId = bericht.sessionId;
        console.log(`  avatarsessie ${bericht.sessionId.slice(0, 8)} gestart`);
        return;
      }
      if (bericht.type === 'stop') {
        /*
         * Een bewuste stop is iets anders dan een weggeklikte tab.
         *
         * Allebei komen ze uiteindelijk aan als een gesloten socket, en dan is er geen
         * verschil meer te zien. Daarom meldt de pagina het vóór het sluiten: dit gesprek
         * is afgerond ('completed'), niet afgebroken ('client_left'). Zonder dit bericht
         * bestond de route 'stopknop' hieronder wel, maar bereikte niemand hem — en dan
         * suggereert het log een onderscheid dat niet gemaakt wordt.
         */
        void beeindig('stopknop');
        return;
      }
      if (bericht.type !== 'start') return;
      /*
       * Hier begint het gesprek, en pas hier begint de klok.
       *
       * Met avatar stuurt de browser dit ná het eerste videoframe, zonder avatar meteen na
       * het opzetten van de keten. In beide gevallen is dit het eerste moment waarop de
       * cliënt iets zou kúnnen zeggen — en dus het vroegste moment waarop stilte iets
       * betekent. De klok stond eerst op het openen van de socket, en dat is seconden
       * eerder dan dit.
       */
      if (gesprekBegonOp === null) gesprekBegonOp = performance.now();
      raakteActief();
      if (sessie) void sessie.loop.open();
      else wilStarten = true;
    } catch {
      /* niet-JSON van de browser negeren we */
    }
  });

  ws.on('close', (code: number, reden: Buffer) => {
    // Niet alleen onze kant loslaten: ook de avatarsessie aan hun kant sluiten. Anders
    // blijft de teller lopen voor een tab die allang weg is.
    void beeindig('tab', `code ${code}${reden ? ` "${String(reden)}"` : ''}`);
  });

  try {
    sessie = await startEchoSession({
      media,
      language: 'nl',
      respond: intake.responseSource(),
      avatarProvider: browserAvatar(new NullAvatarProvider(() => performance.now()), ws),
      onPrematureCut: (_volledig, gapMs, detectedBy) => stuur({ type: 'cut', gapMs, detectedBy }),
      onSkippedTurn: (reden) => stuur({ type: 'skipped', reden }),
      onTurnError: (error) => stuur({ type: 'error', waar: 'beurt', wat: String(error) }),
      onTurn: (turn) => {
        raakteActief();
        // De HUD-regel is dezelfde als in de worker-logs, inclusief de twee signalen
        // voor stil dataverlies.
        stuur({
          type: 'turn',
          client: turn.clientUtterance,
          assistant: turn.assistantContent,
          interrupted: turn.interruptedAtChar !== null,
          hud: formatHudLine(turn.metrics, {
            clientUtteranceWasCut: turn.clientUtteranceWasCut,
            endedBy: turn.endedBy,
            trimmedLeadingMs: turn.trimmedLeadingMs,
            rejectedFacts: 0,
          }),
        });

        // Het koude pad, ná de beurt en buiten de klok. Faalt het, dan raakt dat het
        // gesprek niet — daarom een losse catch en geen await op het spraakpad.
        intake.recordTurn(turn.clientUtterance, turn.assistantContent);
        void intake
          .observe()
          .then((r) => {
            stuur({
              type: 'facts',
              completeness: r.completeness,
              facts: Object.entries(intake.knownFacts()).map(([k, v]) => ({
                key: k,
                value: String(v?.value ?? '—'),
                status: v?.status,
              })),
              risks: r.riskFlags,
              rejected: r.rejectedFacts ?? [],
              ...(r.extractionError ? { extractionError: r.extractionError } : {}),
            });
          })
          .catch((error: unknown) => {
            stuur({ type: 'error', waar: 'cold path', wat: String(error) });
          });
      },
    });
  } catch (error) {
    /*
     * Ook loggen, niet alleen doorsturen.
     *
     * Dit stuurde de fout naar de browser en sloot de socket, zonder één regel op de
     * server. In de pagina werd die melding meteen overschreven door de statusregel van
     * het sluiten zelf, en dan zie je "verbinding gesloten" en verder niets — een
     * kapotte mediaketen die eruitziet als een afsluitprobleem. Dat kostte een sessie
     * zoeken in de verkeerde hoek.
     */
    console.error(`  opstarten mislukt: ${String(error).slice(0, 300)}`);
    stuur({ type: 'error', waar: 'opstarten', wat: String(error) });
    ws.close();
    return;
  }

  // Het sessietoken voor de avatar wordt hier gemaakt en niet in de browser: de API-key
  // hoort op de server te blijven (zelfde principe als ADR-0007).
  // De provider is bij het opstarten al gebouwd en beproefd; hier alleen nog een vers
  // token per sessie. Zo kan de configuratie niet pas bij de eerste bezoeker stuklopen.
  let anamToken: string | null = null;
  let avatarFout: string | null = null;
  if (avatarProviderVoorSessies) {
    try {
      anamToken = await avatarProviderVoorSessies.issueSessionToken();
    } catch (error) {
      avatarFout = String(error).replace(/^Error: /, '');
    }
  }

  // De samplerate meesturen in plaats van hem in de pagina te herhalen. Twee plekken met
  // hetzelfde getal is hoe een mismatch ontstaat, en een mismatch klinkt hier als spraak
  // die te snel of te traag loopt.
  // De providerkeuze gaat expliciet mee, niet impliciet via de aanwezigheid van een token.
  // Anders kan de pagina "geen token" niet onderscheiden van "geen avatar bedoeld", en
  // draait hij zonder gezicht verder terwijl de server iets anders meldt.
  stuur({
    type: 'ready',
    sampleRate: SAMPLE_RATE,
    avatar: AVATAR,
    ...(anamToken ? { anamToken } : {}),
    ...(avatarFout ? { avatarFout } : {}),
  });
  if (wilStarten) void sessie.loop.open();
}

/**
 * Ctrl-c, en dan pas weg.
 *
 * Zonder dit blijft er bij elke serverherstart een avatarsessie draaien tot Anams engine
 * hem na tien tot twintig seconden opruimt. Tijdens een middag ontwikkelen zijn dat
 * tientallen sessies waar niemand naar kijkt.
 *
 * De afsluiting krijgt drie seconden. Lukt het niet, dan gaan we alsnog weg: een server
 * die niet stopt op ctrl-c is erger dan een sessie die blijft hangen.
 */
let stopt = false;
async function stopAlles(signaal: string): Promise<void> {
  if (stopt) return;
  stopt = true;
  const aantal = openVerbindingen.size;
  if (aantal > 0) console.log(`\n  ${signaal}: ${aantal} sessie(s) afsluiten…`);
  const klaar = Promise.all([...openVerbindingen].map((f) => f('server stopt')));
  await Promise.race([klaar, new Promise((r) => setTimeout(r, 3_000))]);
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => void stopAlles('ctrl-c'));
process.on('SIGTERM', () => void stopAlles('SIGTERM'));

/*
 * "stop" typen doet hetzelfde als ctrl-c.
 *
 * Bestaat omdat Windows console-signalen niet programmatisch aflevert: `kill('SIGINT')`
 * op een node-kindproces roept de handler niet aan, het proces wordt gewoon afgebroken.
 * Zonder deze ingang is de afsluitroutine op dit platform niet te toetsen, en dan zou de
 * controle in bakeoff/afsluiten-diagnose.ts alleen kunnen bewijzen dat de regel hierboven
 * er staat — niet dat er iets goeds gebeurt als hij afgaat.
 *
 * Het is dus geen aparte weg naar buiten: exact dezelfde `stopAlles()`.
 */
process.stdin.on('data', (d) => {
  if (String(d).trim() === 'stop') void stopAlles('stop via stdin');
});

server.listen(POORT, () => {
  console.log(`\n  Praat met de intake:  ${METTLS ? 'https' : 'http'}://localhost:${POORT}\n`);
  console.log(`  model ${env.LLM_HOT_MODEL ?? 'claude-haiku-4-5-20251001'} · ${SAMPLE_RATE} Hz`);
  console.log(
    // Deze regel wordt pas bereikt als het sessietoken er echt gekomen is; zie
    // controleerAvatar() hierboven. Een melding die niet kan liegen.
    AVATAR === 'anam' && avatarPersona
      ? `  avatar: Anam · ${avatarPersona.gezicht} · persona "${avatarPersona.naam}" · ` +
          'hun LLM uit (kost avatarminuten)'
      : '  avatar: geen — zet AVATAR_PROVIDER=anam voor een pratend gezicht',
  );
  console.log(
    `  Stop met ctrl-c. Sessie sluit na ${Math.round(INACTIVITEIT_MS / 1000)} s zonder spraak.\n`,
  );
});
