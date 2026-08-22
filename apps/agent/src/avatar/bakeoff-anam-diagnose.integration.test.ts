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
 * Diagnose van het passthrough-harnas, niet van de provider.
 *
 * De eerste 12-beurtenmeting gaf 34, 27, dan oplopend 300–550, dan 931 en 1528. Dat is
 * geen latencyverdeling; daar zit iets in dat zich opbouwt. Deze test isoleert het langs
 * twee assen:
 *
 *   - één audiostroom hergebruiken tegenover een nieuwe per beurt;
 *   - een korte pauze tussen beurten tegenover een lange.
 *
 * En hij registreert per beurt wélk geluid de detector zag, met duur. Een klik van tien
 * milliseconden en een gesproken zin van twee seconden geven hetzelfde onsetgetal.
 *
 * Draait NIET mee met `pnpm test:bakeoff` — dit kost avatarminuten en is een eenmalig
 * onderzoek. Aanzetten met ANAM_DIAGNOSE=1.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BAKEOFF_DIR = join(HERE, '..', '..', 'bakeoff');
const SAMPLE_RATE = 16_000;
const ZIN = 'Goedemiddag, ik ben de digitale intake-assistent.';

const aan = process.env['ANAM_DIAGNOSE'] === '1';
const heeftKeys = Boolean(
  process.env['ANAM_API_KEY'] &&
  process.env['ANAM_AVATAR_ID'] &&
  process.env['CARTESIA_API_KEY'] &&
  process.env['CARTESIA_VOICE_ID'],
);

interface DiagnoseBeurt {
  conditie: string;
  beurt: number;
  onsetMs: number | null;
  verzondenMs: number;
  bursts: Array<{ start: number; duur: number }>;
  fout?: string;
}

const CONDITIES = [
  { naam: 'nieuw/400', beurten: 4, hergebruikStream: false, pauzeMs: 400 },
  { naam: 'nieuw/2500', beurten: 4, hergebruikStream: false, pauzeMs: 2500 },
  { naam: 'hergebruik/400', beurten: 4, hergebruikStream: true, pauzeMs: 400 },
];

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

describe('diagnose Anam-harnas', () => {
  let browser: Browser;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    if (!aan || !heeftKeys) return;
    const clientJs = await bundleClient();
    ({ server, url } = await serve(clientJs));
    browser = await chromium.launch({
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
  });

  it.runIf(aan && heeftKeys)(
    'waar gaat de detector op af, en bouwt er iets op',
    async () => {
      const pcm = await synthetiseer(ZIN);
      const duurMs = Math.round((pcm.length / SAMPLE_RATE) * 1000);
      const base64 = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');

      const provider = new AnamAvatarProvider({
        apiKey: process.env['ANAM_API_KEY']!,
        personaId: process.env['ANAM_AVATAR_ID']!,
      });
      const sessionToken = await provider.issueSessionToken();

      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForFunction(() => typeof window.bakeoff?.anamDiagnose === 'function');

      const rijen = (await page.evaluate(
        async ([token, audio, rate, condities]) =>
          window.bakeoff.anamDiagnose(
            token as string,
            audio as string,
            Number(rate),
            JSON.parse(condities as string),
          ),
        [sessionToken, base64, String(SAMPLE_RATE), JSON.stringify(CONDITIES)],
      )) as DiagnoseBeurt[];

      const regels = [
        ``,
        `  Diagnose Anam-harnas — brontape ${duurMs} ms`,
        `  ${'conditie'.padEnd(16)}${'beurt'.padEnd(7)}${'onset'.padEnd(9)}${'verzonden'.padEnd(11)}bursts (start/duur)`,
      ];
      for (const r of rijen) {
        const bursts = r.bursts.map((b) => `${b.start}/${b.duur}`).join('  ') || '(geen)';
        regels.push(
          `  ${r.conditie.padEnd(16)}${String(r.beurt).padEnd(7)}` +
            `${String(r.onsetMs ?? '—').padEnd(9)}${String(r.verzondenMs).padEnd(11)}${bursts}` +
            (r.fout ? `  FOUT: ${r.fout}` : ''),
        );
      }
      // eslint-disable-next-line no-console
      console.log(regels.join('\n') + '\n');

      await page.close();
      expect(rijen.length).toBe(CONDITIES.reduce((n, c) => n + c.beurten, 0));
    },
    900_000,
  );
});
