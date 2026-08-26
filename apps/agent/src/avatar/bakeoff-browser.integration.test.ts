import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { CartesiaTtsProvider } from '@intake/provider-tts';
import { createAccessToken, type LiveKitCredentials } from '@intake/provider-transport';
import { AnamAvatarProvider } from './anam';
import { BeyondPresenceAvatarProvider } from './beyondpresence';

/**
 * De bakeoff, in een browser.
 *
 * Waarom hier en niet in Node: de twee providers hebben een verschillend transport. Bey
 * publiceert in een LiveKit-room (serverzijdig te bereiken), Anam gebruikt eigen
 * signalling die door hun browser-SDK wordt opgezet. Wie alleen meet wat vanuit Node
 * kan, meet integratiegemak in plaats van kwaliteit. Zie ADR-0010.
 *
 * De meting is voor beide identiek: ónze PCM erin, eerste hoorbare geluid eruit, in een
 * sessie die al warm is. Dat is het getal dat tegen het budget van 180 ms p50 mag, want
 * op dat pad zit de TTS van de leverancier niet in de keten (ADR-0001).
 *
 * Dit start echte sessies en kost avatarminuten. Vandaar `pnpm test:bakeoff`, nooit
 * `pnpm test`, en nooit in CI — de meting hoort bovendien vanaf een machine in Nederland
 * te komen, niet vanuit een runner in een willekeurige regio.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BAKEOFF_DIR = join(HERE, '..', '..', 'bakeoff');

/** Genoeg beurten voor een p50 die iets betekent; zie de kanttekening bij p95 hieronder. */
const BEURTEN = 12;
const SAMPLE_RATE = 16_000;
const ZIN = 'Goedemiddag, ik ben de digitale intake-assistent.';

const heeftCartesia = Boolean(process.env['CARTESIA_API_KEY'] && process.env['CARTESIA_VOICE_ID']);
const heeftAnam = Boolean(process.env['ANAM_API_KEY'] && process.env['ANAM_PERSONA_ID']);
const heeftLivekit = Boolean(
  process.env['LIVEKIT_URL'] && process.env['LIVEKIT_API_KEY'] && process.env['LIVEKIT_API_SECRET'],
);
const heeftBey =
  Boolean(process.env['BEY_API_KEY'] && process.env['BEY_AVATAR_ID']) && heeftLivekit;

function meldOverslaan(): void {
  const ontbreekt: string[] = [];
  if (!heeftCartesia) ontbreekt.push('CARTESIA_API_KEY/CARTESIA_VOICE_ID');
  if (!heeftAnam) ontbreekt.push('ANAM_API_KEY + ANAM_PERSONA_ID');
  if (!heeftBey) ontbreekt.push('BEY_API_KEY/BEY_AVATAR_ID + LIVEKIT_*');
  if (ontbreekt.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`\n[bakeoff] overgeslagen onderdelen — ontbreekt: ${ontbreekt.join(', ')}\n`);
  }
}
meldOverslaan();

/** Bundelt de meetpagina; de SDK's moeten als één bestand de browser in. */
async function bundleClient(): Promise<string> {
  const result = await build({
    entryPoints: [join(BAKEOFF_DIR, 'client.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

/**
 * Serveert de pagina over http.
 *
 * Niet via `file://`: daar gelden andere regels voor modules en getUserMedia, en dan
 * meet je een omgeving die niet lijkt op de echte.
 */
function serve(clientJs: string): Promise<{ server: Server; url: string }> {
  const html = readFileSync(join(BAKEOFF_DIR, 'page.html'), 'utf8');

  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (path.endsWith('client.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(clientJs);
      return;
    }
    if (path === '/' || extname(path) === '.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

interface Meting {
  firstFrameMs: number;
  width: number;
  height: number;
}

interface PassthroughMeting {
  coldStartMs: number;
  responseMs: number[];
  harnasOverheadMs?: number;
}

/**
 * Percentiel via lineaire interpolatie, één implementatie voor beide providers.
 *
 * Dat het gedeeld is, is het punt: twee providers vergelijken met twee rekenmethodes is
 * geen vergelijking.
 */
function percentiel(waarden: readonly number[], p: number): number {
  if (waarden.length === 0) return Number.NaN;
  const gesorteerd = [...waarden].sort((a, b) => a - b);
  const positie = (gesorteerd.length - 1) * p;
  const onder = Math.floor(positie);
  const boven = Math.ceil(positie);
  const laag = gesorteerd[onder] ?? 0;
  if (onder === boven) return laag;
  const hoog = gesorteerd[boven] ?? laag;
  return laag + (hoog - laag) * (positie - onder);
}

function rapporteer(naam: string, meting: PassthroughMeting): void {
  const r = meting.responseMs;
  const regels = [
    ``,
    `  ${naam} — passthrough (ons productiepad, ${r.length} beurten)`,
    `    koude start                  ${meting.coldStartMs} ms  (prewarm dekt dit af)`,
    `    per beurt p50                ${percentiel(r, 0.5).toFixed(0)} ms  (budget 180)`,
    `    per beurt p95                ${percentiel(r, 0.95).toFixed(0)} ms  (budget 350)`,
    `    min / max                    ${Math.min(...r)} / ${Math.max(...r)} ms`,
    `    ruwe waarden                 ${r.join(', ')}`,
  ];
  if (meting.harnasOverheadMs !== undefined) {
    regels.push(
      `    harnasoverhead (in bovenstaande getallen begrepen)  ~${meting.harnasOverheadMs} ms`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(regels.join('\n') + '\n');
}

/** Onze eigen TTS, zodat beide metingen dezelfde audio gebruiken als productie. */
async function synthetiseer(zin: string): Promise<Int16Array> {
  const tts = new CartesiaTtsProvider({ apiKey: process.env['CARTESIA_API_KEY']! });
  const stream = await tts.open({
    voiceId: process.env['CARTESIA_VOICE_ID']!,
    language: 'nl',
    sampleRate: SAMPLE_RATE,
  });

  const chunks: Int16Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthese liep vast')), 30_000);
    stream.on('audio', (c) => chunks.push(c.pcm));
    stream.on('done', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    stream.say(zin);
    stream.flush();
  });
  await stream.close();

  const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  return trimAanloopstilte(pcm);
}

/**
 * Aanloopstilte eraf.
 *
 * Cartesia levert vóór het eerste woord een halve seconde stilte — gemeten 537 ms bij een
 * korte Nederlandse zin. Die stilte gaat in de meting mee als latency: wij starten de klok
 * bij het versturen, de avatar speelt eerst de stilte af, en pas daarna kruist er iets de
 * detectiedrempel.
 *
 * Daardoor waren de passthrough-cijfers niet vergelijkbaar tussen runs, want de hoeveelheid
 * aanloopstilte verschilt per synthese. Het verschil van ~100 ms tussen onze keten en het
 * leveranciersvoorbeeld bleek daar volledig binnen te vallen.
 *
 * Dit snijdt hem eraf voor de méting. Of hij er in productie ook af moet, is een aparte
 * vraag met een groter belang: daar gaat diezelfde stilte wél naar de avatar en wacht de
 * cliënt hem uit.
 */
function trimAanloopstilte(pcm: Int16Array, drempel = 0.01): Int16Array {
  const grens = drempel * 32767;
  let eerste = 0;
  while (eerste < pcm.length && Math.abs(pcm[eerste]!) <= grens) eerste += 1;
  if (eerste === 0 || eerste >= pcm.length) return pcm;
  // eslint-disable-next-line no-console
  console.log(`  (${Math.round((eerste / SAMPLE_RATE) * 1000)} ms aanloopstilte weggesneden)`);
  return pcm.slice(eerste);
}

describe('bakeoff in de browser', () => {
  let browser: Browser;
  let server: Server;
  let url: string;
  let pcm: Int16Array | null = null;

  beforeAll(async () => {
    const clientJs = await bundleClient();
    ({ server, url } = await serve(clientJs));
    browser = await chromium.launch({
      args: [
        // Zonder deze vlaggen weigert Chromium autoplay en mediatoegang in een
        // headless run, en dan komt er nooit een frame.
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
      ],
    });
    if (heeftCartesia) pcm = await synthetiseer(ZIN);
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it.runIf(heeftAnam)(
    'meet Anam: verbinding tot eerste geverfde frame',
    async () => {
      const provider = new AnamAvatarProvider({
        apiKey: process.env['ANAM_API_KEY']!,
        // Avatar wint boven persona; zie AnamOptions. Beide mogen leeg zijn zolang er
        // maar één is ingevuld.
        // Alleen de persona: avatarId en voiceId worden door hun API genegeerd.
        personaId: process.env['ANAM_PERSONA_ID']!,
      });
      const sessionToken = await provider.issueSessionToken();

      const page = await browser.newPage();
      const fouten: string[] = [];
      page.on('pageerror', (error) => fouten.push(error.message));

      await page.goto(url);
      await page.waitForFunction(() => typeof window.bakeoff?.anam === 'function');

      const meting = (await page.evaluate(
        async (token) => window.bakeoff.anam(token),
        sessionToken,
      )) as Meting;

      // Let op wat dit getal wél en niet is.
      //
      // Dit is de KOUDE START: sessie opzetten, WebRTC onderhandelen, eerste frame. Dat is
      // niet de stap uit de latencybegroting — die meet audio erin tot mond beweegt,
      // binnen een sessie die al loopt. De koude start wordt in productie afgedekt door
      // prewarm: de sessie start zodra de cliënt het toestemmingsscherm opent.
      // eslint-disable-next-line no-console
      console.log(
        `\n  Anam — koude start\n` +
          `    sessie -> eerste geverfde frame  ${meting.firstFrameMs} ms\n` +
          `    resolutie                        ${meting.width}x${meting.height}\n` +
          (fouten.length > 0 ? `    paginafouten: ${fouten.slice(0, 3).join(' | ')}\n` : ''),
      );

      await page.close();

      expect(meting.firstFrameMs).toBeGreaterThan(0);
      // Er is echt beeld, geen zwart element: een frame zonder afmetingen betekent dat de
      // videotrack er niet is en dat we een leeg <video> hebben zitten meten.
      expect(meting.width).toBeGreaterThan(0);
      expect(meting.height).toBeGreaterThan(0);
    },
    180_000,
  );

  it.runIf(heeftAnam && heeftCartesia)(
    'meet Anam passthrough: onze audio erin, hoe snel eruit',
    async () => {
      const base64 = Buffer.from(pcm!.buffer, pcm!.byteOffset, pcm!.byteLength).toString('base64');

      const provider = new AnamAvatarProvider({
        apiKey: process.env['ANAM_API_KEY']!,
        // Avatar wint boven persona; zie AnamOptions. Beide mogen leeg zijn zolang er
        // maar één is ingevuld.
        // Alleen de persona: avatarId en voiceId worden door hun API genegeerd.
        personaId: process.env['ANAM_PERSONA_ID']!,
      });
      const sessionToken = await provider.issueSessionToken();

      const page = await browser.newPage();
      const fouten: string[] = [];
      page.on('pageerror', (e) => fouten.push(e.message));
      await page.goto(url);
      await page.waitForFunction(() => typeof window.bakeoff?.anamPassthrough === 'function');

      const meting = (await page.evaluate(
        async ([token, audio, rate, beurten]) =>
          window.bakeoff.anamPassthrough(
            token as string,
            audio as string,
            Number(rate),
            Number(beurten),
          ),
        [sessionToken, base64, String(SAMPLE_RATE), String(BEURTEN)],
      )) as PassthroughMeting;

      rapporteer('Anam', meting);
      if (fouten.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`    paginafouten: ${fouten.slice(0, 2).join(' | ')}\n`);
      }

      await page.close();
      expect(meting.responseMs).toHaveLength(BEURTEN);
      expect(Math.min(...meting.responseMs)).toBeGreaterThan(0);
    },
    600_000,
  );

  it.runIf(heeftBey && heeftCartesia)(
    'meet bey passthrough: onze audio erin, hoe snel eruit',
    async () => {
      const livekit: LiveKitCredentials = {
        url: process.env['LIVEKIT_URL']!,
        apiKey: process.env['LIVEKIT_API_KEY']!,
        apiSecret: process.env['LIVEKIT_API_SECRET']!,
      };

      const roomName = `bakeoff-bey-${Date.now()}`;
      const provider = new BeyondPresenceAvatarProvider({
        apiKey: process.env['BEY_API_KEY']!,
        avatarId: process.env['BEY_AVATAR_ID']!,
        livekit,
        sampleRate: SAMPLE_RATE,
      });

      const session = await provider.createSession({
        avatarId: process.env['BEY_AVATAR_ID']!,
        language: 'nl',
        roomName,
      });

      // De browser kijkt mee als gewone deelnemer. Precies het token dat een cliënt
      // krijgt, zodat we meten wat een cliënt zou zien en horen.
      const viewer = createAccessToken(livekit, {
        room: roomName,
        identity: 'bakeoff-viewer',
        role: 'client',
      });

      const page = await browser.newPage();
      const fouten: string[] = [];
      page.on('pageerror', (e) => fouten.push(e.message));

      // De brug. De browser houdt de klok; Node stuurt de audio op verzoek, op ware
      // snelheid, precies zoals de turn-loop dat in productie doet.
      const frameSamples = (SAMPLE_RATE / 1000) * 20; // 20 ms
      await page.exposeFunction('harnasNoop', async () => undefined);
      await page.exposeFunction('beyPush', async () => {
        let seq = 0;
        for (let offset = 0; offset < pcm!.length; offset += frameSamples) {
          // Zonder pacing, net als aan de Anam-kant. De turn-loop geeft Cartesia-audio
          // door zodra hij binnenkomt; op ware snelheid aanleveren meet een pad dat
          // niemand loopt en telde bij Anam ruim 700 ms extra op.
          //
          // slice en niet subarray: de DataStream-schrijver is asynchroon en een
          // gedeelde buffer zou onder handen kunnen veranderen.
          await session.pushAudio(pcm!.slice(offset, offset + frameSamples), seq);
          seq += 1;
        }
        session.endTurn?.();
      });

      try {
        await page.goto(url);
        await page.waitForFunction(() => typeof window.bakeoff?.beyPassthrough === 'function');

        const meting = (await page.evaluate(
          async ([lkUrl, token, beurten]) =>
            window.bakeoff.beyPassthrough(
              { url: lkUrl as string, token: token as string },
              Number(beurten),
            ),
          [livekit.url, viewer.token, String(BEURTEN)],
        )) as PassthroughMeting;

        rapporteer('Beyond Presence', meting);
        if (fouten.length > 0) {
          // eslint-disable-next-line no-console
          console.log(`    paginafouten: ${fouten.slice(0, 2).join(' | ')}\n`);
        }

        expect(meting.responseMs).toHaveLength(BEURTEN);
        expect(Math.min(...meting.responseMs)).toBeGreaterThan(0);
      } finally {
        await page.close();
        // Altijd afsluiten: een sessie die blijft staan kost avatarminuten door.
        await session.disconnect().catch(() => undefined);
      }
    },
    600_000,
  );
});
