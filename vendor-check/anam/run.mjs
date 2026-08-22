import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

/**
 * Anam, volgens hun eigen quickstart — en drie varianten om één vermoeden te toetsen.
 *
 * De pagina ernaast gebruikt `createClient` en `streamToVideoElement` zoals hun
 * documentatie het voorschrijft. Geen wrapper, geen enkele regel uit onze codebase.
 *
 * ## Wat hier onderzocht wordt
 *
 * Onze keten mat 609 ms passthrough, hun voorbeeld 511 ms. Dat verschil van ~100 ms is
 * een **vermoeden en geen bevinding** zolang de oorzaak niet is aangewezen: twee metingen
 * verschillen op meer dan één ding tegelijk. Twee kandidaten, allebei te toetsen als
 * wijziging in *hun* voorbeeld in plaats van in het onze:
 *
 *   1. **de audio.** Wij sturen Cartesia-spraak, dit voorbeeld een toon van 180 Hz die
 *      vanaf de eerste sample op halve sterkte staat. Spraak begint zacht; een medeklinker
 *      kruist de detectiedrempel later dan een toon die er meteen overheen zit. Dat alleen
 *      al kan honderd milliseconde schelen, zonder dat er iets aan de keten mankeert.
 *
 *   2. **de levering van de SDK.** Wij bundelen met esbuild, hun quickstart laadt van een
 *      CDN. Als dat uitmaakt, moet hun voorbeeld mét bundel trager worden.
 *
 * Drie armen dus: toon+CDN (de basislijn), spraak+CDN, en toon+bundel. Elke arm verandert
 * precies één ding.
 *
 * Draaien met: npm run anam
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.anam.ai/v1';
const SAMPLE_RATE = 16_000;
const BEURTEN = 8;
const ZIN = 'Goedemiddag, ik ben de digitale intake-assistent.';

const apiKey = process.env.ANAM_API_KEY;
const personaId = process.env.ANAM_AVATAR_ID;
if (!apiKey || !personaId) {
  console.error('ANAM_API_KEY of ANAM_AVATAR_ID ontbreekt in ../.env');
  process.exit(1);
}

/** De serverzijdige stap uit hun documentatie: een kortlevend sessietoken. */
async function sessietoken() {
  const res = await fetch(`${API}/auth/session-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaConfig: { personaId } }),
  });
  if (!res.ok) throw new Error(`sessietoken mislukt: HTTP ${res.status} — ${await res.text()}`);
  const body = await res.json();
  if (!body.sessionToken) throw new Error('geen sessionToken in het antwoord');
  return body.sessionToken;
}

/**
 * Ongeveer twee seconden hoorbare toon.
 *
 * Staat vanaf de eerste sample op halve sterkte — en dat is precies de eigenschap die
 * hieronder als hypothese wordt getoetst.
 */
function toon(seconden = 2.1) {
  const n = Math.round(seconden * SAMPLE_RATE);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / SAMPLE_RATE;
    const envelop = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.5 * t);
    pcm[i] = Math.round(Math.sin(2 * Math.PI * 180 * t) * 9000 * envelop);
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64');
}

/**
 * Echte spraak, rechtstreeks bij Cartesia opgehaald.
 *
 * Hun HTTP-API, niet onze provider — deze map hoort geen code van ons te bevatten. Zelfde
 * stem en zelfde zin als onze bakeoff gebruikt, zodat het verschil met de toon alleen
 * over de audio gaat.
 */
async function spraak() {
  const key = process.env.CARTESIA_API_KEY;
  const voice = process.env.CARTESIA_VOICE_ID;
  if (!key || !voice) return null;

  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: ZIN,
      voice: { mode: 'id', id: voice },
      language: 'nl',
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: SAMPLE_RATE,
      },
    }),
  });
  if (!res.ok) {
    console.warn(`  (Cartesia gaf HTTP ${res.status}; spraakarm wordt overgeslagen)`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

/** Dezelfde SDK, maar geplet zoals onze bakeoff dat doet. */
async function bundelSdk() {
  const r = await build({
    stdin: {
      contents: "export { createClient } from '@anam-ai/js-sdk';",
      resolveDir: HIER,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  return r.outputFiles[0].text;
}

const html = readFileSync(join(HIER, 'page.html'), 'utf8');
const bundel = await bundelSdk();

const server = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/sdk-bundle.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundel);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const poort = server.address().port;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
});

const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function arm(naam, { sdk, pcm }) {
  const page = await browser.newPage();
  const fouten = [];
  page.on('pageerror', (e) => fouten.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${poort}/?sdk=${sdk}`);
    await page.waitForFunction(() => typeof window.meet === 'function', { timeout: 30_000 });
    const token = await sessietoken();
    const r = await page.evaluate(
      async ([t, zin, beurten, audio, sr]) =>
        window.meet(t, zin, Number(beurten), audio, Number(sr)),
      [token, ZIN, String(BEURTEN), pcm, String(SAMPLE_RATE)],
    );
    console.log(
      `  ${naam.padEnd(22)}p50 ${String(p50(r.passthroughMs)).padStart(4)} ms   ` +
        `ruw ${r.passthroughMs.join(', ')}`,
    );
    return p50(r.passthroughMs);
  } catch (error) {
    console.log(`  ${naam.padEnd(22)}MISLUKT: ${String(error).slice(0, 160)}`);
    if (fouten.length > 0) console.log(`    paginafouten: ${fouten.slice(0, 2).join(' | ')}`);
    return null;
  } finally {
    await page.close();
  }
}

try {
  const eenToon = toon();
  const eenSpraak = await spraak();

  console.log(`\n  Anam — passthrough, ${BEURTEN} beurten per arm\n`);
  const basis = await arm('toon + CDN', { sdk: 'cdn', pcm: eenToon });
  const metSpraak = eenSpraak ? await arm('spraak + CDN', { sdk: 'cdn', pcm: eenSpraak }) : null;
  const metBundel = await arm('toon + bundel', { sdk: 'bundle', pcm: eenToon });

  console.log(`\n  Onze eigen keten mat 609 ms (spraak + bundel), hun basislijn ${basis} ms.`);
  if (metSpraak !== null) {
    console.log(`  De audio verklaart ${metSpraak - basis} ms van dat verschil.`);
  }
  if (metBundel !== null) {
    console.log(`  De levering van de SDK verklaart ${metBundel - basis} ms.`);
  }
  console.log('');
} finally {
  await browser.close();
  server.close();
}
