import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { CartesiaTtsProvider, type CartesiaTtsStream } from '@intake/provider-tts';
import { AnamAvatarProvider } from './anam';

/**
 * De bakeoff, in een browser.
 *
 * Waarom hier en niet in Node: de twee providers hebben een verschillend transport. Bey
 * publiceert in een LiveKit-room (serverzijdig te bereiken), Anam gebruikt eigen
 * signalling die door hun browser-SDK wordt opgezet. Wie alleen meet wat vanuit Node
 * kan, meet integratiegemak in plaats van kwaliteit. Zie ADR-0010.
 *
 * De meting is voor beide identiek: van "verbinding starten" tot het eerste frame dat de
 * browser daadwerkelijk tekent, via `requestVideoFrameCallback`.
 *
 * Dit start echte sessies en kost avatarminuten. Vandaar `pnpm test:bakeoff`, nooit
 * `pnpm test`, en nooit in CI — de meting hoort bovendien vanaf een machine in Nederland
 * te komen, niet vanuit een runner in een willekeurige regio.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BAKEOFF_DIR = join(HERE, '..', '..', 'bakeoff');

const heeftAnam = Boolean(process.env['ANAM_API_KEY'] && process.env['ANAM_AVATAR_ID']);
const describeLive = heeftAnam ? describe : describe.skip;

if (!heeftAnam) {
  // eslint-disable-next-line no-console
  console.warn('\n[bakeoff-browser] OVERGESLAGEN — ANAM_API_KEY of ANAM_AVATAR_ID ontbreekt.\n');
}

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

interface BeurtMeting {
  coldStartMs: number;
  responseMs: number;
}

const SAMPLE_RATE = 16_000;

/** Onze eigen TTS, zodat de passthrough-meting dezelfde audio gebruikt als productie. */
async function synthetiseer(zin: string): Promise<Int16Array> {
  const tts = new CartesiaTtsProvider({ apiKey: process.env['CARTESIA_API_KEY']! });
  const stream = (await tts.open({
    voiceId: process.env['CARTESIA_VOICE_ID']!,
    language: 'nl',
    sampleRate: SAMPLE_RATE,
  })) as CartesiaTtsStream;

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
  return pcm;
}

describeLive('bakeoff in de browser', () => {
  let browser: Browser;
  let server: Server;
  let url: string;

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
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it('meet Anam: verbinding tot eerste geverfde frame', async () => {
    const provider = new AnamAvatarProvider({
      apiKey: process.env['ANAM_API_KEY']!,
      personaId: process.env['ANAM_AVATAR_ID']!,
    });
    const sessionToken = await provider.issueSessionToken();

    const page = await browser.newPage();
    const fouten: string[] = [];
    page.on('pageerror', (error) => fouten.push(error.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') fouten.push(msg.text());
    });

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
    // binnen een sessie die al loopt. Het naast het p50-budget van 180 ms leggen zou
    // alarmerend ogen en niets betekenen.
    //
    // De koude start wordt in productie afgedekt door prewarm: de sessie start zodra de
    // cliënt het toestemmingsscherm opent, en tegen "START INTAKE" leeft het gezicht al.
    // Dit getal zegt dus hoeveel prewarm-tijd je nodig hebt, niet hoe snel een beurt is.
    // eslint-disable-next-line no-console
    console.log(
      `\n  Anam — koude start\n` +
        `    sessie -> eerste geverfde frame  ${meting.firstFrameMs} ms\n` +
        `    resolutie                        ${meting.width}x${meting.height}\n` +
        `    (prewarm moet hier overheen; niet vergelijken met het p50-budget van 180 ms)\n` +
        (fouten.length > 0 ? `    paginafouten: ${fouten.slice(0, 3).join(' | ')}\n` : ''),
    );

    await page.close();

    expect(meting.firstFrameMs).toBeGreaterThan(0);
    // Er is echt beeld, geen zwart element: een frame zonder afmetingen betekent dat de
    // videotrack er niet is en dat we een leeg <video> hebben zitten meten.
    expect(meting.width).toBeGreaterThan(0);
    expect(meting.height).toBeGreaterThan(0);
  }, 180_000);

  it('meet Anam per beurt: opdracht tot hoorbaar geluid', async () => {
    const provider = new AnamAvatarProvider({
      apiKey: process.env['ANAM_API_KEY']!,
      personaId: process.env['ANAM_AVATAR_ID']!,
    });
    const sessionToken = await provider.issueSessionToken();

    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => typeof window.bakeoff?.anamPerBeurt === 'function');

    const meting = (await page.evaluate(
      async ([token, zin]) => window.bakeoff.anamPerBeurt(token!, zin!),
      [sessionToken, 'Goedemiddag, ik ben de digitale intake-assistent.'],
    )) as BeurtMeting;

    // eslint-disable-next-line no-console
    console.log(
      `
  Anam — per beurt
` +
        `    opdracht -> hoorbaar geluid  ${meting.responseMs} ms  (budget p50 180 / p95 350)
` +
        `    koude start ter referentie   ${meting.coldStartMs} ms
` +
        `    (tekstgestuurd pad; audio passthrough loopt via een andere SDK-aanroep)
`,
    );

    await page.close();
    expect(meting.responseMs).toBeGreaterThan(0);
    // Boven een seconde is het geen avatarlatency meer maar een probleem.
    expect(meting.responseMs).toBeLessThan(5000);
  }, 180_000);

  it('meet Anam passthrough: onze eigen audio erin, hoe snel eruit', async () => {
    // Passthrough is het pad dat we in productie gebruiken: wij doen de TTS, zij
    // renderen alleen. Hun TTS zit dus niet in de keten, en dít getal mag daarom tegen
    // het budget van 180 ms p50.
    const heeftCartesia = process.env['CARTESIA_API_KEY'] && process.env['CARTESIA_VOICE_ID'];
    if (!heeftCartesia) {
      // eslint-disable-next-line no-console
      console.warn('\n  passthrough overgeslagen — Cartesia-keys ontbreken\n');
      return;
    }

    const pcm = await synthetiseer('Goedemiddag, ik ben de digitale intake-assistent.');
    const base64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');

    const provider = new AnamAvatarProvider({
      apiKey: process.env['ANAM_API_KEY']!,
      personaId: process.env['ANAM_AVATAR_ID']!,
    });
    const sessionToken = await provider.issueSessionToken();

    const page = await browser.newPage();
    const fouten: string[] = [];
    page.on('pageerror', (e) => fouten.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => typeof window.bakeoff?.anamPassthrough === 'function');

    const meting = (await page.evaluate(
      async ([token, audio, rate]) =>
        window.bakeoff.anamPassthrough(token as string, audio as string, Number(rate)),
      [sessionToken, base64, String(SAMPLE_RATE)],
    )) as BeurtMeting;

    // eslint-disable-next-line no-console
    console.log(
      `\n  Anam — passthrough (ons productiepad)\n` +
        `    onze audio erin -> hoorbaar eruit  ${meting.responseMs} ms  (budget p50 180 / p95 350)\n` +
        (fouten.length > 0 ? `    paginafouten: ${fouten.slice(0, 2).join(' | ')}\n` : ''),
    );

    await page.close();
    expect(meting.responseMs).toBeGreaterThan(0);
    expect(meting.responseMs).toBeLessThan(5000);
  }, 180_000);
});
