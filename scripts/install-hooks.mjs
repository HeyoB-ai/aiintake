import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * De git-haken aanzetten, zonder de installatie te kunnen breken.
 *
 * ## Waarom via `core.hooksPath` en niet in `.git/hooks`
 *
 * Die map staat niet in git. Een haak die je daar neerzet, heeft alleen jij — en dan is
 * "draait die controle bij iedereen?" een vraag die niemand kan beantwoorden. `.githooks/`
 * staat wél in de repo; deze regel wijst git ernaar.
 *
 * ## Waarom dit een script is en geen regel in package.json
 *
 * `prepare` draait bij elke `pnpm install`, dus ook op de buildmachine van Netlify en in de
 * container van Railway. Daar is niet gegarandeerd een `.git` aanwezig — een builder die de
 * bestanden kopieert in plaats van te clonen, heeft hem niet — en `git config` faalt dan met
 * een exitcode. Als dat rechtstreeks in `prepare` staat, faalt de hele installatie en
 * daarmee de deploy, om een haak die daar niets te zoeken heeft.
 *
 * Vandaar: geen `.git`, dan stilletjes niets doen. Lukt het niet om een andere reden, dan
 * één regel uitleg en alsnog exitcode 0 — een ontwikkelgemak hoort geen build te breken.
 */

const REPO = process.cwd();

if (!existsSync(join(REPO, '.git'))) {
  // Geen git-werkboom: dit is een buildmachine of een uitgepakt archief.
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: REPO, stdio: 'ignore' });
} catch {
  console.log(
    '  (git-haken niet ingesteld; `pnpm db:status` draait dan niet vanzelf vóór een push)',
  );
}
