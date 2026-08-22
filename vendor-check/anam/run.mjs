import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

/**
 * Anam, volgens hun eigen quickstart.
 *
 * De pagina ernaast laadt hun SDK rechtstreeks van een CDN en gebruikt `createClient` en
 * `streamToVideoElement` zoals hun documentatie het voorschrijft. Geen bundler van ons,
 * geen wrapper, geen enkele regel uit onze codebase.
 *
 * Twee getallen komen eruit:
 *
 *   `talk()`        hun tekstgestuurde pad — hún TTS zit in de keten
 *   passthrough     onze audio erin, zij renderen alleen — ons productiepad
 *
 * Gemeten op 23 augustus 2026, tien beurten, naast een verse meting van onze eigen keten
 * op dezelfde dag:
 *
 *   hun voorbeeld    passthrough p50 511 ms   (spreiding 500-517)
 *   onze keten       passthrough p50 609 ms   (spreiding 599-644)
 *
 * Ongeveer honderd milliseconde verschil. Onze integratie kost dus iets, maar het leeuwen-
 * deel — ruim vijfhonderd milliseconde — zit in hun pipeline en is met geen enkele
 * wijziging aan onze kant weg te halen.
 *
 * **Kanttekening bij de audio.** De passthrough-proef gebruikt een synthetische toon en
 * geen echte spraak, zodat deze map geen tweede leverancier nodig heeft. Voor de meting
 * maakt dat niet uit — de vulgrens van ~730 ms gaat over de duur van de audio, niet over
 * de inhoud — maar het toetst wel het transport en niet de spraakkwaliteit.
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.anam.ai/v1';
const SAMPLE_RATE = 16_000;
const BEURTEN = 10;
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
 * Ongeveer twee seconden hoorbare audio.
 *
 * Een toon met een amplitude-envelop: luid genoeg voor de RMS-drempel, en met stiltes
 * ertussen zodat het geen constante zoem is die een detector op één plek laat vastzitten.
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

const html = readFileSync(join(HIER, 'page.html'), 'utf8');
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const poort = server.address().port;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
});
const page = await browser.newPage();
const fouten = [];
page.on('pageerror', (e) => fouten.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') fouten.push(m.text());
});

try {
  await page.goto(`http://127.0.0.1:${poort}/`);
  await page.waitForFunction(() => typeof window.meet === 'function', { timeout: 30_000 });

  const token = await sessietoken();
  const r = await page.evaluate(
    async ([t, zin, beurten, pcm, sr]) => window.meet(t, zin, Number(beurten), pcm, Number(sr)),
    [token, ZIN, String(BEURTEN), toon(), String(SAMPLE_RATE)],
  );

  const p50 = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

  console.log(`\n  Anam — voorbeeld van de leverancier, ${r.resolutie}`);
  console.log(`    koude start        ${r.coldStartMs} ms`);
  console.log(`    talk()             p50 ${p50(r.talkMs)} ms   ruw ${r.talkMs.join(', ')}`);
  console.log(`    passthrough        p50 ${p50(r.passthroughMs)} ms   ruw ${r.passthroughMs.join(', ')}`);
  console.log(
    `\n  Onze keten mat ~800 ms voor passthrough. Ligt dit getal daar duidelijk onder,\n` +
      `  dan zit de vertraging bij ons; ligt het ernaast, dan is het hun pipeline.\n`,
  );
  if (fouten.length > 0) console.log(`  paginafouten: ${fouten.slice(0, 3).join(' | ')}\n`);
} catch (error) {
  console.error('\n  MISLUKT:', String(error).slice(0, 500));
  if (fouten.length > 0) console.error('  paginafouten:', fouten.slice(0, 3).join(' | '));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
