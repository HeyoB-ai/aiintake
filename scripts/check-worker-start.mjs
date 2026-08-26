import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Start de worker die op Railway draait, en kijkt of hij overeind komt.
 *
 * ## Waarom dit bestaat
 *
 * De worker crashte bij elke herstart op `Cannot read properties of undefined (reading 'tts')`
 * — een variabele die op moduleniveau werd gelezen voordat hij bestond. Alles was groen:
 * typecheck, tests, `samplerate:check`, de hele reeks.
 *
 * Er waren twee gaten en ze verklaren elk een deel:
 *
 *  1. `live/` stond niet in de tsconfig van `apps/agent`. Zie `pnpm typecheck:dekking`.
 *  2. **Niets startte de worker ooit.** `build:worker` bundelt met esbuild en schrijft
 *     `dist/worker.js` weg; daarna draaide er niemand dat bestand tot Railway het deed.
 *
 * Het tweede is het zwaardere gat. Een typecheck vangt een typefout; hij vangt geen
 * ontbrekende omgevingsvariabele, geen import die in de bundel anders uitpakt, en geen fout
 * die pas bij het uitvoeren van moduleniveau ontstaat. Voor die klasse bestaat maar één
 * controle: het ding daadwerkelijk starten.
 *
 * Deze had de crash gevangen zonder dat de typecheck-poort was gerepareerd, want hij draait
 * exact de bundel die naar productie gaat.
 *
 * ## Wat hij doet
 *
 * De bundel starten op een eigen poort, wachten tot `/health` antwoordt, en weer afsluiten.
 * Antwoordt hij niet — of valt het proces om — dan komt de uitvoer van het proces erbij, want
 * "de worker start niet" zonder de melding is precies zo nutteloos als de crash zelf.
 *
 * ## Waarom hij niet hard faalt zonder sleutels
 *
 * De worker eist een echte omgeving: zonder `ANTHROPIC_API_KEY` stopt hij bewust met een
 * melding, en dat is juist gedrag. Ontbreekt die configuratie hier, dan kan deze controle geen
 * uitspraak doen. Hij zegt dat dan luid en laat door — dezelfde afweging als bij
 * `db:status`: een controle die standaard wordt overgeslagen, bewaakt niets meer, maar een
 * controle die in de trein hard faalt, leert mensen `--no-verify` typen.
 *
 * Het verschil tussen "gestart en goed" en "niet kunnen starten" staat in de uitvoer.
 *
 * Draaien met: pnpm worker:start-check
 */

const REPO = process.cwd();
const BUNDEL = join(REPO, 'apps', 'agent', 'dist', 'worker.js');
const POORT = Number(process.env['WORKER_CHECK_PORT'] ?? 5199);
const GEDULD_MS = 20_000;

console.log('\n  Start de worker die op Railway draait\n');

if (!existsSync(BUNDEL)) {
  console.log('  NIET GECONTROLEERD: dist/worker.js bestaat niet.');
  console.log('  Draai eerst `pnpm --filter @intake/agent build:worker`.\n');
  process.exit(0);
}

/** De omgeving uit .env erbij, want de worker eist een echte configuratie. */
function omgeving() {
  const uit = { ...process.env, PORT: String(POORT) };
  const pad = join(REPO, '.env');
  if (!existsSync(pad)) return uit;
  for (const regel of readFileSync(pad, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(regel);
    // Een lege waarde is geen waarde; en wat al in de omgeving staat, wint.
    if (m && m[2].trim() !== '' && uit[m[1]] === undefined) uit[m[1]] = m[2].trim();
  }
  return uit;
}

const env = omgeving();
const NODIG = [
  'ANTHROPIC_API_KEY',
  'DEEPGRAM_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
];
const mist = NODIG.filter((n) => !env[n]);
if (mist.length > 0) {
  console.log(`  NIET GECONTROLEERD: ${mist.join(', ')} ontbreekt.`);
  console.log('  De worker weigert dan met opzet te starten, dus dit zegt niets over de code.\n');
  process.exit(0);
}

const proces = spawn(process.execPath, [BUNDEL], {
  env,
  cwd: join(REPO, 'apps', 'agent'),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let uitvoer = '';
proces.stdout.on('data', (d) => (uitvoer += d.toString()));
proces.stderr.on('data', (d) => (uitvoer += d.toString()));

let afgelopen = null;
proces.on('exit', (code, signaal) => {
  afgelopen = signaal ? `signaal ${signaal}` : `afsluitcode ${code}`;
});

function faal(reden) {
  console.log(`  DE WORKER KOMT NIET OVEREIND: ${reden}\n`);
  const regels = uitvoer.trim().split(/\r?\n/).filter(Boolean);
  if (regels.length === 0) console.log('    (het proces zei niets)');
  // De laatste regels, want daar staat de fout; de opstartbanner is hier niet interessant.
  for (const r of regels.slice(-25)) console.log(`    ${r}`);
  console.log('');
  try {
    proces.kill();
  } catch {
    /* al weg */
  }
  process.exit(1);
}

const begin = Date.now();
while (Date.now() - begin < GEDULD_MS) {
  if (afgelopen) faal(`het proces stopte met ${afgelopen}`);
  try {
    const res = await fetch(`http://127.0.0.1:${POORT}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (res.ok) {
      proces.kill();
      console.log(`  De worker start en antwoordt op /health (${Date.now() - begin} ms).\n`);
      process.exit(0);
    }
  } catch {
    // Nog niet aan het luisteren. Dat is de normale toestand in de eerste seconden.
  }
  await new Promise((r) => setTimeout(r, 250));
}

faal(`geen antwoord op /health binnen ${GEDULD_MS / 1000} s`);
