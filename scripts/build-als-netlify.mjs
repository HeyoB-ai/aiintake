import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
 * 2. **Een verse install uit de gecommitte lockfile.** `--frozen-lockfile` faalt als de
 *    lockfile niet meer bij de package.json's past. Dat is op zichzelf al een vangst: die
 *    mismatch is anders precies het moment waarop de buildmachine andere versies pakt.
 * 3. **Hetzelfde commando.** `turbo run build --filter @intake/web`, met `--force` zodat de
 *    turbo-cache geen groen resultaat van gisteren teruggeeft.
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
const FILTER = process.argv[2] ?? '@intake/web';

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
}

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

/*
 * Een tijdelijke commit van de werkboom, zodat ook níet-gecommitte wijzigingen meegaan.
 *
 * `git stash create` maakt zo'n commit zonder de werkboom aan te raken en zonder iets op de
 * stash-stapel te zetten — er valt hier dus niets kwijt te raken. Zonder wijzigingen geeft
 * hij een lege string; dan is HEAD wat er gebouwd wordt.
 */
const boom = git('stash', 'create') || 'HEAD';
const map = mkdtempSync(join(tmpdir(), 'netlify-build-'));

console.log(`\n  Bouwen vanaf ${boom === 'HEAD' ? 'HEAD' : boom.slice(0, 8)} in ${map}\n`);

let code = 0;
try {
  git('worktree', 'add', '--detach', map, boom);

  console.log('  [1/2] pnpm install --frozen-lockfile\n');
  execSync('pnpm install --frozen-lockfile', { cwd: map, stdio: 'inherit' });

  console.log(`\n  [2/2] turbo run build --filter ${FILTER}\n`);
  execSync(`npx turbo run build --filter ${FILTER} --force`, {
    cwd: map,
    stdio: 'inherit',
    // Netlify bouwt met NODE_ENV=production. Dat is niet cosmetisch: het bepaalt onder meer
    // of een installer devDependencies overslaat en welke tak van de code wordt gebundeld.
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
