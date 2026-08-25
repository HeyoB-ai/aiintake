import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

/**
 * Blijft Anams eigen stem stil?
 *
 * Bij elke sessiestart klonk eerst een kort Spaans fragment in een andere stem. Dat is
 * hun TTS, aangedreven door hun LLM, en bij passthrough hoort daar niets uit te komen —
 * een tweede stem in een intakegesprek is geen schoonheidsfoutje maar een productfout.
 *
 * Deze meting opent een sessie, **zegt niets**, en luistert acht seconden of er tóch
 * geluid uit de avatar komt. Dat is het hele oordeel: piek-RMS onder de ruisdrempel is
 * stil, alles daarboven is hun stem.
 *
 * Er worden meerdere persona's naast elkaar gelegd, zodat het verschil aan één ding hangt
 * en niet aan "het lijkt nu beter". Welke: uit ANAM_PERSONA_ID (wat er nu draait) en
 * ANAM_STILLE_PERSONA_ID (de eigen persona met llmId CUSTOMER_CLIENT_V1).
 *
 * Kost avatarminuten: één sessie per persona.
 *
 * Draaien met: pnpm --filter @intake/agent diag:stilte
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const API = 'https://api.anam.ai/v1';
const SECONDEN = 8;

const apiKey = process.env['ANAM_API_KEY'];
if (!apiKey) throw new Error('ANAM_API_KEY ontbreekt in .env');

interface Kandidaat {
  readonly naam: string;
  readonly personaId: string;
}

const kandidaten: Kandidaat[] = [
  ...(process.env['ANAM_PERSONA_ID']
    ? [{ naam: 'huidige (ANAM_PERSONA_ID)', personaId: process.env['ANAM_PERSONA_ID'] }]
    : []),
  ...(process.env['ANAM_STILLE_PERSONA_ID']
    ? [{ naam: 'eigen (llm uit)', personaId: process.env['ANAM_STILLE_PERSONA_ID'] }]
    : []),
];

if (kandidaten.length === 0) {
  throw new Error('Zet ANAM_PERSONA_ID en/of ANAM_STILLE_PERSONA_ID in .env');
}

/** Wat de persona aan hun kant werkelijk is — niet wat wij dénken dat hij is. */
async function persona(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/personas/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`persona ${id} lezen mislukt: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Token voor een opgeslagen persona.
 *
 * Bewust alleen `personaId`: dit meet wat de persona zelf doet. Een config met avatarId
 * erbij zou een tweede variabele introduceren, en dan meet je twee dingen tegelijk.
 */
async function sessietoken(personaId: string): Promise<string> {
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
const bundel = sdk.outputFiles[0]?.text ?? '';
const html = readFileSync(join(HIER, 'stilte-page.html'), 'utf8');

const server = createServer((req, res) => {
  if ((req.url ?? '').startsWith('/sdk.js')) {
    res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundel);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const poort = (server.address() as { port: number }).port;

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
});

interface Uitkomst {
  /** Piek-RMS terwijl wij niets sturen. Alles hierboven is hun eigen stem. */
  readonly piek: number;
  /** Piek-RMS nadat wij zelf een toon hebben gestuurd. De tegenproef. */
  readonly piekEigen: number;
  readonly luideMonsters: number[];
  readonly gebeurtenissen: { ev: string; p: string }[];
}

const uitkomsten: { naam: string; oordeel: 'stil' | 'geluid' | 'mislukt'; detail: string }[] = [];

try {
  console.log(
    `\n  Anam — komt er geluid uit zonder dat wij iets sturen? (${SECONDEN} s per persona)\n`,
  );

  for (const k of kandidaten) {
    const p = await persona(k.personaId);
    const avatar = p['avatar'] as { displayName?: string } | undefined;
    console.log(
      `  ${k.naam}\n` +
        `    gezicht ${avatar?.displayName ?? '?'} · taal ${String(p['languageCode'])} · ` +
        `llmId ${String(p['llmId']).slice(0, 24)} · ` +
        `passthrough ${String(p['enableAudioPassthrough'])} · ` +
        `skipGreeting ${String(p['skipGreeting'])}`,
    );

    const page = await browser.newPage();
    try {
      await page.goto(`http://127.0.0.1:${poort}/`);
      await page.waitForFunction(
        () => typeof (window as never as { meet?: unknown }).meet === 'function',
        {
          timeout: 30_000,
        },
      );
      const token = await sessietoken(k.personaId);
      const r = (await page.evaluate(
        async ([t, s]) =>
          (window as never as { meet: (a: string, b: number) => Promise<unknown> }).meet(
            t as string,
            Number(s),
          ),
        [token, String(SECONDEN)],
      )) as Uitkomst;

      const detail =
        `uit zichzelf ${r.piek} · na onze toon ${r.piekEigen}` +
        (r.luideMonsters.length > 0 ? ` · eerste geluid op ${r.luideMonsters[0]} ms` : '');
      const oordeel = r.piek > 0.01 ? ('geluid' as const) : ('stil' as const);
      uitkomsten.push({ naam: k.naam, oordeel, detail });
      console.log(
        `    ${oordeel === 'geluid' ? 'GELUID uit zichzelf' : 'stil uit zichzelf'} — ${detail}`,
      );
      console.log(
        `    onze audio komt ${r.piekEigen > 0.01 ? 'WEL' : 'NIET'} door de avatar` +
          (r.piekEigen > 0.01 ? '' : ' — stilte bewijst dan niets'),
      );
      for (const g of r.gebeurtenissen.slice(0, 3)) console.log(`    ${g.ev}: ${g.p}`);
    } catch (error) {
      // Een arm die niet draaide is géén bevinding. Hem als "hun stem staat aan" tellen
      // maakt een mislukking tot een meetresultaat, en dat is precies hoe eerder vier
      // latencycijfers zijn ontstaan die achteraf artefacten bleken.
      const detail = String(error)
        .replace(/^Error: /, '')
        .slice(0, 200);
      uitkomsten.push({ naam: k.naam, oordeel: 'mislukt', detail });
      console.log(`    MISLUKT (geen meting): ${detail}`);
    } finally {
      await page.close();
    }
    console.log('');

    // Hun sessie mag aflopen voordat de volgende begint; anders loopt de tweede arm tegen
    // de gelijktijdigheidslimiet en lijkt dat een bevinding. Hoe lang een afgesloten
    // sessie blijft meetellen is precies wat er in de supportmelding aan Anam is gevraagd
    // en nog niet beantwoord; 20 s is de ondergrens die in de praktijk werkte.
    await new Promise((r) => setTimeout(r, 20_000));
  }
} finally {
  await browser.close();
  server.close();
}

for (const u of uitkomsten) console.log(`  ${u.naam.padEnd(26)} ${u.oordeel}`);

const gemeten = uitkomsten.filter((u) => u.oordeel !== 'mislukt');
const metGeluid = gemeten.filter((u) => u.oordeel === 'geluid');
console.log(
  gemeten.length === 0
    ? '\n  Niets gemeten — alle armen liepen stuk. Geen conclusie.\n'
    : metGeluid.length === 0
      ? `\n  ${gemeten.length} persona(s) gemeten, geen enkele produceerde geluid uit zichzelf.\n`
      : `\n  Geluid zonder dat wij iets stuurden bij: ${metGeluid.map((u) => u.naam).join(', ')}.\n`,
);
process.exit(gemeten.length > 0 && metGeluid.length === 0 ? 0 : 1);
