import { builtinModules } from 'node:module';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Importeert een package iets dat het zelf niet declareert?
 *
 * ## Waarom dit niet aan de build overgelaten kan worden
 *
 * `lucide-react` stond alleen in `packages/ui/package.json`, en `apps/web` importeerde hem
 * rechtstreeks in drie bestanden. Lokaal ging dat goed, hier én in het nabootsingsscript,
 * en op Netlify faalde de build met "Cannot find module 'lucide-react'".
 *
 * De oorzaak was geen pnpm-instelling maar een `node_modules` in de thuismap van de
 * gebruiker. Node zoekt een bare import op door van de importerende map naar boven te
 * lopen tot de schijfwortel — `apps/web/node_modules`, `apps/node_modules`,
 * `<repo>/node_modules`, en dan gewoon verder: `C:\Users\<naam>\node_modules`. Ligt daar
 * iets, dan resolvet elk project onder die thuismap het, zonder het te declareren.
 *
 * Dat maakt een groene build op de machine van de ontwikkelaar geen bewijs. Erger: het
 * maakt ook het nabootsingsscript geen bewijs, want dat bouwt in een tijdelijke map die
 * meestal óók onder diezelfde thuismap ligt. Twee controles die allebei dezelfde blinde
 * vlek hebben, geven twee keer hetzelfde onterechte groen.
 *
 * Deze controle kijkt daarom niet naar wat resolvet maar naar wat er staat: elke bare
 * import in de broncode van een package, vergeleken met wat dat package in zijn eigen
 * `package.json` declareert. Waar de mappen op deze machine liggen doet er dan niet toe.
 *
 * ## Waarom het per package is en niet per repo
 *
 * De hele monorepo bij elkaar heeft `lucide-react` wél. Dat is precies de val: pnpm
 * installeert per package, en de buildmachine krijgt voor `apps/web` alleen wat `apps/web`
 * declareert. "Het staat ergens in de workspace" is geen declaratie.
 *
 * ## Wat dit niet vangt
 *
 * De regex leest geen TypeScript. Een import die met een variabele wordt samengesteld
 * (`import(pad)`) staat hier niet in, en een specifier in een string die toevallig op een
 * import lijkt wordt eruit gefilterd op vorm. Dat is bewust de kant waarop hij mis mag
 * zitten: een gemiste import kost een deploy, een valse melding kost vertrouwen in de
 * controle.
 *
 * Draaien met: pnpm deps:check
 */

const BUILTIN = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const BRON = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const OVERSLAAN = ['node_modules', 'dist', '.next', '.turbo', '.git', 'generated'];

/** Een pakketnaam bevat geen witruimte en begint niet met een leesteken. */
const PAKKETVORM = /^@?[a-z0-9][a-z0-9._~/-]*$/i;

const SPEC =
  /(?:^|[\s;])(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s+['"]([^'"]+)['"]/gm;

function mappenMetPackageJson(map, uit = []) {
  if (!existsSync(map)) return uit;
  for (const naam of readdirSync(map)) {
    if (OVERSLAAN.includes(naam)) continue;
    const pad = join(map, naam);
    if (!statSync(pad).isDirectory()) continue;
    if (existsSync(join(pad, 'package.json'))) uit.push(pad);
    else mappenMetPackageJson(pad, uit);
  }
  return uit;
}

function bronbestanden(map, uit = []) {
  for (const naam of readdirSync(map)) {
    if (OVERSLAAN.includes(naam)) continue;
    const pad = join(map, naam);
    const st = statSync(pad);
    if (st.isDirectory()) bronbestanden(pad, uit);
    else if (BRON.test(naam)) uit.push(pad);
  }
  return uit;
}

/** "@scope/pkg/sub" -> "@scope/pkg", "next/server" -> "next" */
function pakketnaam(spec) {
  const delen = spec.split('/');
  return spec.startsWith('@') ? `${delen[0]}/${delen[1]}` : delen[0];
}

/**
 * @param {string} repo hoofdmap van de monorepo
 * @returns {{ pakket: string, map: string, ontbreekt: Map<string, string[]> }[]}
 */
export function vindFantomen(repo) {
  const mappen = [
    ...mappenMetPackageJson(join(repo, 'apps')),
    ...mappenMetPackageJson(join(repo, 'packages')),
  ];

  const uitkomst = [];
  for (const map of mappen) {
    const pkg = JSON.parse(readFileSync(join(map, 'package.json'), 'utf8'));
    const gedeclareerd = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      // Een package mag naar zichzelf verwijzen.
      pkg.name,
    ]);

    const ontbreekt = new Map();
    for (const bestand of bronbestanden(map)) {
      for (const m of readFileSync(bestand, 'utf8').matchAll(SPEC)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) {
          continue;
        }
        if (!PAKKETVORM.test(spec)) continue;
        if (BUILTIN.has(spec)) continue;
        const naam = pakketnaam(spec);
        if (BUILTIN.has(naam) || gedeclareerd.has(naam)) continue;
        const bestanden = ontbreekt.get(naam) ?? [];
        const relatief = relative(repo, bestand).replace(/\\/g, '/');
        if (!bestanden.includes(relatief)) bestanden.push(relatief);
        ontbreekt.set(naam, bestanden);
      }
    }
    if (ontbreekt.size > 0) {
      uitkomst.push({ pakket: pkg.name, map: relative(repo, map).replace(/\\/g, '/'), ontbreekt });
    }
  }
  return uitkomst;
}

/** Print het resultaat en geef terug of er iets mis is. */
export function meldFantomen(fantomen) {
  if (fantomen.length === 0) return false;
  console.error('\n  Deze imports staan niet in de package.json van het package zelf:\n');
  for (const { pakket, map, ontbreekt } of fantomen) {
    console.error(`    ${pakket}  (${map})`);
    for (const [naam, bestanden] of [...ontbreekt].sort()) {
      console.error(`      ${naam}`);
      for (const b of bestanden.sort()) console.error(`          ${b}`);
    }
  }
  console.error(
    '\n  Ze resolven hier waarschijnlijk via een node_modules boven de repo. Op de\n' +
      '  buildmachine bestaat die niet. Voeg ze toe aan de juiste package.json.\n',
  );
  return true;
}

// Rechtstreeks aangeroepen: zelf rapporteren en met een exitcode eindigen.
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const fantomen = vindFantomen(process.cwd());
  if (meldFantomen(fantomen)) process.exit(1);
  console.log('\n  Geen fantoomafhankelijkheden.\n');
}
