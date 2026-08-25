import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vindFantomen, meldFantomen } from './check-fantoom-deps.mjs';

/**
 * De productiebuild draaien zoals de buildmachine hem draait.
 *
 * ## Waarom `pnpm typecheck` niet genoeg was
 *
 * Die draait `tsc --noEmit` in de mappen zoals ze hier staan: met een `node_modules` die in
 * de loop van weken is gegroeid, met bestanden die nog niet in git zitten, en zonder dat er
 * ooit iets uit de gecommitte lockfile is geïnstalleerd. Alle drie die verschillen kunnen
 * een build breken die hier groen is, en alle drie zijn ze onzichtbaar zolang je nooit
 * opnieuw installeert.
 *
 * Dit script haalt die verschillen weg door precies te bouwen wat de buildmachine krijgt:
 *
 * 1. **Alleen wat git kent.** Een losse kopie via `git worktree`, gemaakt van een tijdelijke
 *    commit met je huidige wijzigingen erin. Wat niet in git zit, zit hier niet in — en dus
 *    ook niet op de buildmachine.
 * 2. **Hetzelfde commando, uit `netlify.toml` gelezen.** Zie hieronder.
 *
 * ## Waarom het commando niet meer in dit bestand staat
 *
 * Hier stond `turbo run build --filter @intake/web --force`, terwijl `netlify.toml`
 * inmiddels `pnpm install --frozen-lockfile --prod=false && pnpm --filter @intake/web
 * build` draaide. Twee commando's die allebei "de build" heten en niet hetzelfde doen: het
 * ene sloeg `--prod=false` over, het andere ging langs de turbo-cache. Een nabootsing die
 * iets anders draait dan het origineel, bootst niets na — hij geeft alleen een groen dat op
 * niets slaat.
 *
 * Daarom leest dit script `[build].command` uit `netlify.toml` en voert dat letterlijk uit.
 * Wijzigt dat bestand, dan wijzigt deze controle mee, zonder dat iemand eraan hoeft te
 * denken. Hetzelfde geldt voor `railway.json` en de worker; die drift bestaat nog wel.
 *
 * ## De blinde vlek die dit script had
 *
 * Node zoekt een bare import op door van de importerende map naar boven te lopen tot de
 * schijfwortel. Ligt er een `node_modules` in de thuismap van de gebruiker, dan resolvet
 * elk project daaronder wat daarin staat — ook zonder het te declareren. Dit script bouwde
 * in `os.tmpdir()`, en dat ligt op Windows onder diezelfde thuismap. De blinde vlek van de
 * werkboom was dus ook de blinde vlek van de controle: `lucide-react` ontbrak in
 * `apps/web/package.json`, en beide gaven groen.
 *
 * Een andere buildmap kiezen lost dat niet op — elke schrijfbare map ligt onder een map die
 * een `node_modules` kán hebben. Wat wel werkt is er niet meer van afhangen: stap 0 kijkt
 * statisch naar de imports en de package.json's, en die uitkomst is onafhankelijk van waar
 * de mappen op deze machine staan.
 *
 * ## Wat dit niet dekt
 *
 * De buildmachine draait Linux, dit draait op wat je hier hebt. Verschillen die aan het
 * platform hangen — bestandsnamen die alleen in hoofdlettergebruik verschillen, een
 * afhankelijkheid met een eigen binary per besturingssysteem — komen hier niet boven. Dat is
 * een beperking en geen detail; een groene uitkomst hier betekent "de repo klopt", niet
 * "de deploy slaagt".
 *
 * Draaien met: pnpm build:netlify
 */

const REPO = process.cwd();

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

/**
 * `[build].command` uit netlify.toml.
 *
 * Bewust geen TOML-bibliotheek: er is één veld nodig en een afhankelijkheid erbij voor het
 * lezen van één regel is duurder dan hij oplost. Wel hard falen als het veld er niet staat
 * of niet te lezen is — stilletjes terugvallen op een ingebakken commando is precies de
 * drift die dit moet voorkomen.
 */
function netlifyBuildCommando(pad) {
  if (!existsSync(pad)) {
    throw new Error(`${pad} bestaat niet; zonder dat bestand is er niets na te bootsen.`);
  }
  const regels = readFileSync(pad, 'utf8').split(/\r?\n/);
  let tabel = '';
  for (const regel of regels) {
    const kop = regel.match(/^\s*\[([^\]]+)\]\s*$/);
    if (kop) {
      tabel = kop[1].trim();
      continue;
    }
    if (tabel !== 'build') continue;
    const veld = regel.match(/^\s*command\s*=\s*(['"])([\s\S]*)\1\s*$/);
    if (veld) return veld[2];
  }
  throw new Error(`Geen [build].command gevonden in ${pad}.`);
}

/*
 * Stap 0. Wat een node_modules boven de repo verbergt.
 *
 * Eerst, want hij kost niets en hij vangt precies de klasse fouten waar de rest van dit
 * script blind voor is.
 */
console.log('\n  [0/2] imports tegen de package.json\'s\n');
if (meldFantomen(vindFantomen(REPO))) process.exit(1);
console.log('        geen fantoomafhankelijkheden');

/*
 * Bestanden die git niet kent, bestaan voor de buildmachine niet.
 *
 * Dit is geen theoretische zorg: een nieuwe route die nog untracked is, bouwt hier prima mee
 * en ontbreekt daar volledig. Dan zoek je naar een 404 op een pagina die je zelf net hebt
 * zien werken. Liever hier stoppen met de lijst erbij.
 */
const onbekend = git('ls-files', '--others', '--exclude-standard')
  .split('\n')
  .filter((r) => r && !r.startsWith('.certs/'));

if (onbekend.length > 0) {
  console.error('\n  Deze bestanden kent git niet, dus de buildmachine krijgt ze ook niet:\n');
  for (const r of onbekend.slice(0, 25)) console.error(`    ${r}`);
  if (onbekend.length > 25) console.error(`    … en nog ${onbekend.length - 25}`);
  console.error('\n  Doe eerst `git add` (of zet ze in .gitignore) en draai opnieuw.\n');
  process.exit(1);
}

const commando = netlifyBuildCommando(join(REPO, 'netlify.toml'));

/*
 * Een tijdelijke commit van de werkboom, zodat ook níet-gecommitte wijzigingen meegaan.
 *
 * `git stash create` maakt zo'n commit zonder de werkboom aan te raken en zonder iets op de
 * stash-stapel te zetten — er valt hier dus niets kwijt te raken. Zonder wijzigingen geeft
 * hij een lege string; dan is HEAD wat er gebouwd wordt.
 */
const boom = git('stash', 'create') || 'HEAD';
const map = mkdtempSync(join(tmpdir(), 'netlify-build-'));

console.log(`\n  [1/2] worktree vanaf ${boom === 'HEAD' ? 'HEAD' : boom.slice(0, 8)}\n`);
console.log(`        ${map}`);

/*
 * Melden welke node_modules boven de buildmap liggen.
 *
 * Niet om erop te falen — stap 0 dekt de klasse fouten die ze verbergen — maar omdat een
 * lezer die dit script vertrouwt hoort te weten waar zijn blinde vlek zit.
 */
const buren = [];
for (let d = map; ; d = dirname(d)) {
  if (existsSync(join(d, 'node_modules'))) buren.push(join(d, 'node_modules'));
  if (dirname(d) === d) break;
}
if (buren.length > 0) {
  console.log('\n        Let op: deze node_modules liggen boven de buildmap en doen mee');
  console.log('        aan het opzoeken van imports. Stap 0 vangt af wat ze verbergen.');
  for (const b of buren) console.log(`          ${b}`);
}

let code = 0;
try {
  git('worktree', 'add', '--detach', map, boom);

  console.log(`\n  [2/2] ${commando}\n`);
  execSync(commando, {
    cwd: map,
    stdio: 'inherit',
    // Netlify bouwt met NODE_ENV=production. Dat is niet cosmetisch: het bepaalt onder meer
    // of een installer devDependencies overslaat en welke tak van de code wordt gebundeld.
    // Het is ook precies de reden dat --prod=false in het commando staat.
    env: { ...process.env, NODE_ENV: 'production' },
  });

  console.log('\n  Groen. Deze repo bouwt zoals hij in git staat.\n');
} catch {
  code = 1;
  console.error('\n  Rood. Dit is wat de buildmachine ook zou zien.\n');
} finally {
  // Opruimen, ook na een fout: een blijvende worktree laat `git worktree list` vollopen met
  // mappen die niet meer bestaan.
  try {
    execFileSync('git', ['worktree', 'remove', '--force', map], { cwd: REPO, stdio: 'ignore' });
  } catch {
    rmSync(map, { recursive: true, force: true });
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: REPO, stdio: 'ignore' });
    } catch {
      // Niets aan te doen; de volgende `git worktree prune` ruimt het op.
    }
  }
}

process.exit(code);
