import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { teltTikkenPcm16, upsamplePcm16 } from '@intake/provider-tts';

/**
 * Waar komen de tikken vandaan — onze 16 kHz, of Anams resampler?
 *
 * De tikken zijn hoorbaar bij elke persona, dus ze zitten niet in de persona-configuratie
 * maar in de audioverwerking. Wij leveren 16 kHz omdat Cartesia's WebSocket niets anders
 * geeft (risico 12); Anam neemt 24 kHz aan. Er zit dus hoe dan ook een resamplingstap
 * tussen, en de vraag is wie hem doet.
 *
 * ## Drie armen, één verschil per arm
 *
 *   A. 16 kHz — de huidige weg.
 *   B. 24 kHz, door ons opgeschaald vanaf **exact dezelfde** 16 kHz-bron. Verschil met A
 *      is alleen wie de resampling doet. Geen naïeve interpolatie: gevensterde sinc, met
 *      een test die vastlegt dat het opschalen zelf geen tikken maakt.
 *   C. 24 kHz rechtstreeks van Cartesia's REST-API. Die honoreert `sample_rate` wél. Dit
 *      is een diagnose en geen productieweg: REST is niet streamend en kost dus latency.
 *      Let op dat dit een **andere generatie** audio is dan A en B — het model produceert
 *      niet sample-voor-sample hetzelfde. Daarom wordt ook de bron zelf gemeten.
 *
 * ## Waarom de bron óók gemeten wordt
 *
 * Zonder de bronmeting is "de uitvoer heeft tikken" niet te onderscheiden van "de bron had
 * ze al". Dezelfde detector aan beide kanten; twee verschillende detectors zouden dat
 * verschil zelf kunnen maken.
 *
 * Kost avatarminuten: één sessie per arm.
 *
 * Draaien met: pnpm --filter @intake/agent diag:tikken
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.anam.ai/v1';
const ZIN =
  'Goedemiddag, u spreekt met de AI-intake-assistent van het kantoor. ' +
  'Vertelt u eens rustig wat er is gebeurd op uw werk.';
/** Seconden nadraaien na de laatste chunk, zodat de staart van de beurt meekomt. */
const NALOOP = 4;

function nodig(naam: string): string {
  const waarde = process.env[naam];
  if (!waarde) throw new Error(`${naam} ontbreekt in .env`);
  return waarde;
}

const apiKey = nodig('ANAM_API_KEY');
const personaId = nodig('ANAM_PERSONA_ID');
const cartesiaKey = nodig('CARTESIA_API_KEY');
const cartesiaVoice = nodig('CARTESIA_VOICE_ID');

/** Spraak van Cartesia's REST-API, die `sample_rate` wél honoreert. */
async function spraak(sampleRate: number): Promise<Int16Array> {
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': cartesiaKey,
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: 'sonic-3',
      transcript: ZIN,
      voice: { mode: 'id', id: cartesiaVoice },
      language: 'nl',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: sampleRate },
    }),
  });
  if (!res.ok) throw new Error(`Cartesia HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}

async function sessietoken(): Promise<string> {
  const res = await fetch(`${API}/auth/session-token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaConfig: { personaId } }),
  });
  if (!res.ok) throw new Error(`sessietoken mislukt: HTTP ${res.status} — ${await res.text()}`);
  const body = (await res.json()) as { sessionToken?: string };
  if (!body.sessionToken) throw new Error('geen sessionToken in het antwoord');
  return body.sessionToken;
}

const base64 = (p: Int16Array): string =>
  Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString('base64');

console.log('\n  Spraak ophalen bij Cartesia (REST, twee samplerates)…');
const bron16 = await spraak(16_000);
const bron24 = await spraak(24_000);
const opgeschaald = upsamplePcm16(bron16, 16_000, 24_000);

interface Arm {
  readonly naam: string;
  readonly pcm: Int16Array;
  readonly rate: number;
}

const armen: Arm[] = [
  { naam: 'A · 16 kHz (huidig)', pcm: bron16, rate: 16_000 },
  { naam: 'B · 24 kHz, wij schalen op', pcm: opgeschaald, rate: 24_000 },
  { naam: 'C · 24 kHz van Cartesia REST', pcm: bron24, rate: 24_000 },
];

console.log('\n  De bron, vóór hij naar Anam gaat:\n');
for (const a of armen) {
  const m = teltTikkenPcm16(a.pcm, a.rate);
  console.log(
    `  ${a.naam.padEnd(30)} ${String(m.aantal).padStart(3)} tikken · ` +
      `${m.perSeconde.toFixed(2)}/s · ${m.duurMs} ms`,
  );
}

// Met ALLEEN_BRON draait de bronmeting zonder een enkele avatarsessie. Bedoeld om de
// detector op echte audio te toetsen zonder minuten te verbranden.
if (process.env['ALLEEN_BRON']) process.exit(0);

const sdk = await build({
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
// Precies dezelfde detector als hierboven, gebundeld voor de browser. Twee implementaties
// zouden het verschil kunnen zijn dat we denken te meten.
const detector = await build({
  entryPoints: [join(HIER, '..', '..', '..', 'packages', 'providers', 'tts', 'src', 'tikken.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  write: false,
  logLevel: 'silent',
});

const html = readFileSync(join(HIER, 'tikken-page.html'), 'utf8');
const server = createServer((req, res) => {
  const url = req.url ?? '/';
  if (url.startsWith('/sdk.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(sdk.outputFiles[0]?.text ?? '');
    return;
  }
  if (url.startsWith('/tikken.js')) {
    res
      .writeHead(200, { 'Content-Type': 'text/javascript' })
      .end(detector.outputFiles[0]?.text ?? '');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const poort = (server.address() as { port: number }).port;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
});

interface Uit {
  readonly aantal: number;
  readonly perSeconde: number;
  readonly zwaarste: number;
  readonly posities: number[];
  readonly duurMs: number;
  readonly piek: number;
  readonly opnameRate: number;
}

const resultaten: { naam: string; uit: Uit | null; fout?: string }[] = [];

console.log('\n  Wat er uit de avatar terugkomt:\n');
try {
  for (const a of armen) {
    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${poort}/`);
      await page.waitForFunction(
        () => typeof (window as never as { meet?: unknown }).meet === 'function',
        { timeout: 30_000 },
      );
      const token = await sessietoken();
      const seconden = a.pcm.length / a.rate + NALOOP;
      const uit = (await page.evaluate(
        async ([t, pcm, rate, sec]) =>
          (
            window as never as {
              meet: (a: string, b: string, c: number, d: number) => Promise<unknown>;
            }
          ).meet(t as string, pcm as string, Number(rate), Number(sec)),
        [token, base64(a.pcm), String(a.rate), String(seconden)],
        // page.evaluate heeft een ruime timeout nodig: de arm draait op realtime tempo.
      )) as Uit;

      resultaten.push({ naam: a.naam, uit });
      console.log(
        `  ${a.naam.padEnd(30)} ${String(uit.aantal).padStart(3)} tikken · ` +
          `${uit.perSeconde.toFixed(2)}/s · zwaarste ${uit.zwaarste}× · ` +
          `piek ${uit.piek} · opgenomen op ${uit.opnameRate} Hz`,
      );
      if (uit.posities.length > 0) {
        console.log(`  ${' '.repeat(30)} eerste op ${uit.posities.slice(0, 6).join(', ')} ms`);
      }
      if (uit.piek < 0.01) {
        console.log(`  ${' '.repeat(30)} LET OP: bijna geen audio opgenomen — arm onbruikbaar`);
      }
    } catch (error) {
      const fout = String(error)
        .replace(/^Error: /, '')
        .slice(0, 200);
      resultaten.push({ naam: a.naam, uit: null, fout });
      console.log(`  ${a.naam.padEnd(30)} MISLUKT (geen meting): ${fout}`);
    } finally {
      await page.close();
    }
    // Hun gelijktijdigheidslimiet telt sessies die nog aan het afsluiten zijn mee.
    await new Promise((r) => setTimeout(r, 20_000));
  }
} finally {
  await browser.close();
  server.close();
}

const bruikbaar = resultaten.filter(
  (r): r is { naam: string; uit: Uit } => r.uit !== null && r.uit.piek >= 0.01,
);

console.log('');
if (bruikbaar.length < 2) {
  console.log('  Minder dan twee bruikbare armen — geen vergelijking, dus geen conclusie.\n');
  process.exit(1);
}

const a16 = bruikbaar.find((r) => r.naam.startsWith('A'));
const beste = bruikbaar.reduce((x, y) => (y.uit.perSeconde < x.uit.perSeconde ? y : x));
if (a16 && beste !== a16 && beste.uit.perSeconde < a16.uit.perSeconde / 2) {
  console.log(
    `  ${beste.naam} heeft minder dan de helft van de tikken van 16 kHz ` +
      `(${beste.uit.perSeconde.toFixed(2)}/s tegen ${a16.uit.perSeconde.toFixed(2)}/s).\n` +
      '  Dat wijst naar de resamplingstap. Bevestig het door te luisteren voordat het een\n' +
      '  bevinding wordt — dit is één meting langs één weg.\n',
  );
} else {
  console.log(
    '  Geen arm springt eruit: de samplerate verklaart de tikken niet.\n' +
      '  Dan zit het elders in hun verwerking, en is dit een vraag voor hun support.\n',
  );
}
