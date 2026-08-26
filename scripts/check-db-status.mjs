import { execSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Staat op de database wat er in de repo staat?
 *
 * ## Waarom dit bestaat
 *
 * Twee deploys op rij strandden op iets wat alleen buiten de repo zichtbaar was: eerst
 * ontbrekende env-variabelen in Netlify, daarna drie migraties die wel gecommit waren en
 * niet toegepast. Beide keren was alles groen — typecheck, tests, `pnpm build:netlify` —
 * omdat elke controle keek naar wat er in git staat en geen enkele naar wat de deploy zou
 * aantreffen.
 *
 * Dit is de tegenhanger van `build:netlify`. Die vraagt "bouwt de repo?"; deze vraagt
 * "past de repo op de database die er straks onder ligt?".
 *
 * ## Wat het faalgeval concreet was
 *
 * `create_public_intake` kreeg er drie parameters bij. De web-app stuurde er veertien naar
 * een functie die er elf kende. PostgREST zoekt op de namen in de body, vond geen match, en
 * gaf PGRST202 — die tot dat moment in een catch-all verdween. De bezoeker las "Het gesprek
 * kon niet worden gestart", en het functielog toonde geen enkele fout.
 *
 * ## Wat het níét controleert
 *
 * Alleen of elke lokale migratie in de migratiegeschiedenis van het project staat. Niet of
 * de inhoud van die migratie daar ook werkelijk is uitgevoerd — iemand die met de hand in
 * de database heeft gewerkt, of een migratie die halverwege is afgebroken, komt hier niet
 * boven. Dat is een beperking en geen detail: dit zegt "de reeks is bijgewerkt", niet "de
 * database klopt".
 *
 * En het kijkt naar het gelinkte project uit `supabase/.temp/project-ref`. Draai je tegen
 * een ander project, dan zegt deze uitkomst niets over dát project.
 *
 * ## Waarom het niet hard faalt als het niet kan kijken
 *
 * Zonder netwerk of zonder ingelogde CLI kan deze controle geen uitspraak doen. Hij meldt
 * dat dan luid en laat door. Hard falen zou betekenen dat wie in de trein zit `--no-verify`
 * leert typen, en een controle die standaard wordt overgeslagen bewaakt niets meer. Het
 * verschil tussen "gecontroleerd en goed" en "niet kunnen controleren" staat in de uitvoer,
 * en dat is precies het onderscheid dat hier telt.
 *
 * Draaien met: pnpm db:status
 */

const REPO = process.cwd();
const MIGRATIES = join(REPO, 'supabase', 'migrations');
const PROJECT_REF = join(REPO, 'supabase', '.temp', 'project-ref');

/** De versiestempels van de lokale migratiebestanden, op volgorde. */
function lokaleVersies() {
  return readdirSync(MIGRATIES)
    .filter((n) => n.endsWith('.sql'))
    .map((n) => ({ versie: n.slice(0, 14), bestand: n }))
    .filter((m) => /^\d{14}$/.test(m.versie))
    .sort((a, b) => a.versie.localeCompare(b.versie));
}

/**
 * De migratiegeschiedenis van het gelinkte project.
 *
 * `supabase migration list` schrijft JSON op de laatste regel, met wat voortgangstekst
 * ervoor. Vandaar dat er naar de laatste regel wordt gezocht die als JSON leest, in plaats
 * van de hele uitvoer te parsen.
 */
function remoteVersies() {
  // Via de shell, want op Windows is de pnpm-ingang een `.cmd` en die kan `execFileSync`
  // niet rechtstreeks starten (EINVAL). Het commando is vast en bevat geen invoer van
  // buiten, dus er valt hier niets te injecteren.
  const uit = execSync('pnpm exec supabase migration list --linked', {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  for (const regel of uit.trim().split(/\r?\n/).reverse()) {
    if (!regel.trim().startsWith('{')) continue;
    const data = JSON.parse(regel);
    if (!Array.isArray(data.migrations)) continue;
    return new Set(data.migrations.map((m) => m.remote).filter(Boolean));
  }
  throw new Error('geen migratielijst in de uitvoer van de supabase-CLI');
}

if (!existsSync(PROJECT_REF)) {
  console.log('\n  Geen gelinkt Supabase-project (supabase/.temp/project-ref ontbreekt).');
  console.log('  Overgeslagen — dit zegt niets over de database van je deploy.\n');
  process.exit(0);
}

const lokaal = lokaleVersies();

let remote;
try {
  remote = remoteVersies();
} catch (fout) {
  console.log('\n  Kon de migratiegeschiedenis niet ophalen:');
  console.log(`    ${String(fout).split('\n')[0]}`);
  console.log('  Overgeslagen — dit is géén goedkeuring, alleen een gemiste controle.\n');
  process.exit(0);
}

const ontbreekt = lokaal.filter((m) => !remote.has(m.versie));

if (ontbreekt.length > 0) {
  console.error('\n  Deze migraties staan in de repo en niet op de database:\n');
  for (const m of ontbreekt) console.error(`    ${m.bestand}`);
  console.error(
    '\n  Draai `pnpm db:push` vóór de deploy. Doe je dat niet, dan praat de web-app\n' +
      '  tegen een schema dat zijn aanroepen niet kent, en dat komt binnen als een\n' +
      '  algemene foutmelding bij de bezoeker.\n',
  );
  process.exit(1);
}

console.log(`\n  Database bij: ${lokaal.length} migraties, allemaal toegepast.\n`);
