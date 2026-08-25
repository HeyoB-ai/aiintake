import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';

/**
 * Sluit de avatarsessie werkelijk af — volgens húń administratie, niet die van ons.
 *
 * ## Waarom dit langs hun API moet
 *
 * "Wij hebben de sessie losgelaten" en "de sessie is dicht" zijn twee verschillende
 * dingen, en het verschil is geld. Gemeten: een tab die hard wordt weggeklikt zonder af te
 * sluiten blijft **10 tot 20 seconden** doorlopen tot Anams engine hem opruimt
 * (`exitStatus: CLOSED_BY_ENGINE`). Onze kant zag daar niets van.
 *
 * Daarom kijkt deze controle naar `GET /v1/sessions` en naar het veld `endTime`. Zolang
 * dat leeg is, loopt de teller.
 *
 * ## De drie wegen naar buiten
 *
 *   1. **De pagina verdwijnt** — wegklikken, verversen, browser dicht.
 *   2. **De server stopt** — ctrl-c tijdens ontwikkelen.
 *   3. **Niemand zegt iets** — de inactiviteitsklok.
 *
 * Alle drie eindigen bij `POST /v1/sessions/{id}/stop` vanaf de server. De browser doet
 * het ook, maar een afgebroken pagina maakt geen asynchroon werk meer af; de server ziet
 * de socket dichtgaan en heeft dat probleem niet.
 *
 * ## Kosten
 *
 * Drie korte sessies, elk enkele seconden. De inactiviteitsdrempel wordt via
 * `INACTIVITEIT_MS` verlaagd, anders zou geval 3 negentig seconden duren — en dan draait
 * niemand deze controle.
 *
 * Draaien met: pnpm --filter @intake/agent diag:afsluiten
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.anam.ai/v1';
const POORT = 5188;
const INACTIVITEIT_MS = 10_000;
/**
 * Het respijt na de start, ook verlaagd.
 *
 * In productie 30 s: de openingsbeurt duurt al zo'n vijftien seconden en daarna hoort
 * iemand te kunnen nadenken. De klok gaat dus pas af op respijt + limiet, en dat is wat
 * hier getoetst wordt.
 */
const RESPIJT_MS = 5_000;
/** Ruimte boven de gemeten ~10-20 s waarin hun engine zelf opruimt. */
const GEDULD_MS = 8_000;

function nodig(naam: string): string {
  const waarde = process.env[naam];
  if (!waarde) throw new Error(`${naam} ontbreekt in .env`);
  return waarde;
}
const apiKey = nodig('ANAM_API_KEY');
nodig('ANAM_PERSONA_ID');

interface Sessie {
  readonly id: string;
  readonly endTime: string | null;
  readonly exitStatus: string | null;
}

async function sessie(id: string): Promise<Sessie | null> {
  const res = await fetch(`${API}/sessions`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`sessies ophalen mislukt: HTTP ${res.status}`);
  const body = (await res.json()) as { data: Sessie[] };
  return body.data.find((s) => s.id === id) ?? null;
}

/** Wacht tot de sessie dicht is, en geeft terug hoe lang dat duurde. */
async function wachtTotDicht(id: string, maxMs: number): Promise<number | null> {
  const t0 = performance.now();
  for (;;) {
    const s = await sessie(id);
    if (s?.endTime) return Math.round(performance.now() - t0);
    if (performance.now() - t0 > maxMs) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** De liveserver als kindproces, zodat we hem echt een signaal kunnen sturen. */
function startServer(): Promise<ChildProcess> {
  // `node --import tsx` in plaats van een pad naar tsx' cli: pnpm hoist niet naar de
  // hoofdmap, dus dat pad bestaat hier niet. De cwd op apps/agent zetten zorgt dat tsx
  // vanuit de werkruimte van de agent wordt gevonden.
  const kind = spawn(process.execPath, ['--import', 'tsx', join(HIER, '..', 'live', 'server.ts')], {
    cwd: join(HIER, '..'),
    env: {
      ...process.env,
      AVATAR_PROVIDER: 'anam',
      LIVE_PORT: String(POORT),
      INACTIVITEIT_MS: String(INACTIVITEIT_MS),
      RESPIJT_MS: String(RESPIJT_MS),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((klaar, mis) => {
    const tijd = setTimeout(() => mis(new Error('server startte niet binnen 40 s')), 40_000);
    kind.stdout?.on('data', (d: Buffer) => {
      if (String(d).includes('Stop met ctrl-c')) {
        clearTimeout(tijd);
        klaar(kind);
      }
    });
    kind.stderr?.on('data', (d: Buffer) => process.stderr.write(`    [server] ${String(d)}`));
    kind.on('exit', (code) => {
      clearTimeout(tijd);
      mis(new Error(`server stopte met code ${code}`));
    });
  });
}

/**
 * Opent de pagina, drukt op start, en geeft het Anam-sessie-id terug.
 *
 * Het id komt uit de pagina zelf (`getActiveSessionId()`), want dat is precies het id dat
 * de server te horen krijgt. Zouden we het uit de sessielijst raden, dan zou de controle
 * een andere sessie kunnen volgen dan de pagina draait.
 */
async function openSessie(browser: Browser): Promise<{ id: string; sluit: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${POORT}/`);
  await page.click('#start');
  await page.waitForFunction(
    () => document.querySelector('.stap[data-stap="frame"]')?.classList.contains('klaar'),
    { timeout: 60_000 },
  );
  const id = (await page.evaluate(
    () => (window as unknown as { __anamSessionId?: string }).__anamSessionId ?? null,
  )) as string | null;
  if (!id) throw new Error('de pagina gaf geen Anam-sessie-id');
  return { id, sluit: () => ctx.close() };
}

const uitslagen: { geval: string; ok: boolean; detail: string }[] = [];
const meld = (geval: string, ok: boolean, detail: string): void => {
  uitslagen.push({ geval, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FOUT'} ${geval} — ${detail}`);
};

/**
 * Een neppe microfoon die zwíjgt.
 *
 * `--use-fake-device-for-media-stream` levert een continue pieptoon. Die komt door de
 * ruispoort heen, telt bij de server als spraak, en houdt de inactiviteitsklok eeuwig
 * tegen — de test zat dus zelf te praten. Dat kostte een run: geval 3 meldde "de klok
 * loopt niet" terwijl de klok deed wat hij hoort te doen.
 *
 * Met `--use-file-for-fake-audio-capture` speelt Chrome een bestand af. Een seconde
 * digitale stilte, in een lus, is een microfoon in een lege kamer.
 */
function stilteBestand(): string {
  const rate = 16_000;
  const monsters = rate; // één seconde
  const data = Buffer.alloc(monsters * 2); // nullen: stilte
  const kop = Buffer.alloc(44);
  kop.write('RIFF', 0);
  kop.writeUInt32LE(36 + data.length, 4);
  kop.write('WAVE', 8);
  kop.write('fmt ', 12);
  kop.writeUInt32LE(16, 16);
  kop.writeUInt16LE(1, 20); // PCM
  kop.writeUInt16LE(1, 22); // mono
  kop.writeUInt32LE(rate, 24);
  kop.writeUInt32LE(rate * 2, 28);
  kop.writeUInt16LE(2, 32);
  kop.writeUInt16LE(16, 34);
  kop.write('data', 36);
  kop.writeUInt32LE(data.length, 40);
  const pad = join(tmpdir(), 'intake-stilte-16k.wav');
  writeFileSync(pad, Buffer.concat([kop, data]));
  return pad;
}

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${stilteBestand()}`,
  ],
});

console.log('\n  Sluit de avatarsessie echt af? Gecontroleerd via GET /v1/sessions.\n');

let server: ChildProcess | null = null;
try {
  // ── 1. De pagina verdwijnt ────────────────────────────────────────────────────
  server = await startServer();
  {
    const { id, sluit } = await openSessie(browser);
    console.log(`  sessie ${id.slice(0, 8)} · tab wordt weggeklikt`);
    await sluit();
    const ms = await wachtTotDicht(id, GEDULD_MS);
    const s = await sessie(id);
    meld(
      'pagina weg',
      ms !== null,
      ms === null
        ? `na ${GEDULD_MS} ms nog open — dan wacht je op hun engine`
        : `dicht na ${ms} ms · exitStatus ${s?.exitStatus ?? '-'}`,
    );
  }

  // ── 2. De server krijgt ctrl-c ────────────────────────────────────────────────
  {
    const { id, sluit } = await openSessie(browser);
    console.log(`  sessie ${id.slice(0, 8)} · server sluit af (dezelfde routine als ctrl-c)`);
    const gestopt = new Promise<void>((r) => server?.once('exit', () => r()));
    /*
     * Via stdin en niet via een signaal.
     *
     * Windows levert console-signalen niet programmatisch af: `kill('SIGINT')` op een
     * node-kindproces roept de handler niet aan — gemeten, het proces bleef gewoon
     * draaien. Daarom de stdin-ingang, die exact dezelfde `stopAlles()` aanroept als
     * ctrl-c. Wat hiermee dus **niet** bewezen is, is dat `process.on('SIGINT')` afgaat;
     * dat is één regel en het is op dit platform niet te toetsen. Wat wél bewezen wordt is
     * dat de afsluitroutine de sessie aan hun kant sluit, en dat was de vraag.
     */
    server?.stdin?.write('stop\n');
    await Promise.race([gestopt, new Promise((r) => setTimeout(r, 8_000))]);
    const ms = await wachtTotDicht(id, GEDULD_MS);
    const s = await sessie(id);
    meld(
      'server stopt',
      ms !== null,
      ms === null
        ? `na ${GEDULD_MS} ms nog open`
        : `dicht na ${ms} ms · exitStatus ${s?.exitStatus ?? '-'}`,
    );
    await sluit();
    server = null;
  }

  // ── 3. Niemand zegt iets ──────────────────────────────────────────────────────
  server = await startServer();
  {
    const { id, sluit } = await openSessie(browser);
    console.log(
      `  sessie ${id.slice(0, 8)} · niemand praat (respijt ${RESPIJT_MS} + limiet ${INACTIVITEIT_MS} ms)`,
    );
    // De pagina blijft bewust open: dit geval gaat er juist over dat er níéts gebeurt.
    const ms = await wachtTotDicht(id, RESPIJT_MS + INACTIVITEIT_MS + GEDULD_MS + 5_000);
    const s = await sessie(id);
    meld(
      'inactiviteit',
      // Niet alleen dát hij sluit: ook niet te vroeg. Te vroeg afkappen breekt een
      // gesprek af, en dat is de fout die deze hele ronde veroorzaakte.
      ms !== null && ms >= RESPIJT_MS + INACTIVITEIT_MS - 3_000,
      ms === null
        ? 'nooit dichtgegaan — de klok loopt niet'
        : `dicht na ${ms} ms · exitStatus ${s?.exitStatus ?? '-'}`,
    );
    await sluit();
  }
} catch (error) {
  meld(
    'harnas',
    false,
    String(error)
      .replace(/^Error: /, '')
      .slice(0, 200),
  );
} finally {
  await browser.close();
  server?.kill('SIGKILL');
}

const alles = uitslagen.length === 3 && uitslagen.every((u) => u.ok);
console.log(
  alles
    ? '\n  Alle drie de wegen sluiten de sessie aan hun kant.\n'
    : '\n  NIET IN ORDE — er lekken avatarminuten weg.\n',
);
process.exit(alles ? 0 : 1);
