#!/usr/bin/env node
/**
 * Controleert dat de boundary-regels niet vacuüm zijn.
 *
 * `depcruise` meldt "no dependency violations found" net zo vrolijk wanneer de regels
 * werken als wanneer ze nergens meer op kunnen matchen. Twee keer is dat hier misgegaan,
 * beide keren zonder dat er iets rood werd:
 *
 *   1. de vendorpatronen waren geankerd op `^`, terwijl een geïnstalleerd pakket als
 *      `node_modules/<naam>/...` in de graaf staat;
 *   2. `exclude` bevatte het kale patroon `dist`, dat de buildmap van élk npm-pakket
 *      wegfilterde — @livekit/agents (dist/) verdween, zod (lib/) bleef.
 *
 * Na (2) kon `engine-no-vendor-sdk` überhaupt niet meer vuren voor een gedeclareerde
 * dependency, en dat is precies het geval dat de regel moet afvangen. Een groene build
 * betekende niets.
 *
 * Deze controle kijkt daarom niet naar overtredingen maar naar de graaf zelf: staan de
 * npm-dependencies er in, en zijn de vendor-SDK's die we daadwerkelijk gebruiken zichtbaar
 * als npm-dependency? Zo niet, dan is er geen regel meer, alleen nog een vinkje.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VENDOR_SDK_PATTERN = /(^|node_modules\/)(@livekit\/|@deepgram\/|@cartesia\/|@supabase\/)/;

function cruise() {
  // Het .mjs-startpunt via `node`, en niet `npx`: op Windows is `npx` een .cmd-shim die
  // execFileSync zonder shell niet kan starten, en met shell zou dit van PATH afhangen.
  //
  // Het pad wordt uit de mappenstructuur afgeleid en niet via require.resolve: de
  // exports-map van dependency-cruiser stelt noch bin/ noch package.json beschikbaar,
  // dus elke resolve-poging eindigt in ERR_PACKAGE_PATH_NOT_EXPORTED.
  const cli = fileURLToPath(
    new URL('../node_modules/dependency-cruiser/bin/dependency-cruise.mjs', import.meta.url),
  );
  if (!existsSync(cli)) {
    console.error(`Kan dependency-cruiser niet vinden op ${cli}. Draai eerst pnpm install.`);
    process.exit(1);
  }

  const raw = execFileSync(
    process.execPath,
    [cli, '--config', '.dependency-cruiser.cjs', '--output-type', 'json', 'packages', 'apps'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(raw);
}

const fouten = [];
const graaf = cruise();

const npmDeps = [];
const vendorDeps = [];
for (const module of graaf.modules) {
  for (const dep of module.dependencies ?? []) {
    if (!(dep.dependencyTypes ?? []).includes('npm')) continue;
    npmDeps.push({ from: module.source, to: dep.resolved });
    if (VENDOR_SDK_PATTERN.test(dep.resolved ?? '')) {
      vendorDeps.push({ from: module.source, to: dep.module });
    }
  }
}

if (npmDeps.length === 0) {
  fouten.push(
    'Geen enkele npm-dependency in de graaf. Elke regel met dependencyTypes: ["npm"] — ' +
      'engine-no-vendor-sdk en not-to-dev-dep — kan dan niet meer vuren. ' +
      'Kijk naar options.exclude in .dependency-cruiser.cjs.',
  );
}

if (vendorDeps.length === 0) {
  fouten.push(
    'Geen enkele vendor-SDK zichtbaar als npm-dependency, terwijl apps/agent er meerdere ' +
      'gebruikt (@livekit/agents, @deepgram/sdk, ...). De vendorregels matchen dus op ' +
      'niets. Controleer of options.exclude de dist-map van npm-pakketten wegfiltert.',
  );
}

if (fouten.length > 0) {
  console.error('\nDe architectuurgrenzen zijn niet effectief:\n');
  for (const fout of fouten) console.error(`  - ${fout}\n`);
  process.exit(1);
}

console.log(
  `Grenzen effectief: ${npmDeps.length} npm-dependencies in de graaf, ` +
    `waarvan ${vendorDeps.length} vendor-SDK's.`,
);
