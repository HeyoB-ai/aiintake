import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Rekent er ergens iets anders een tijd uit dan `@intake/domain/tijd`?
 *
 * ## Wat er misging
 *
 * De dossierpagina toonde "Ontvangen 27-08-2026, 11:53" voor een gesprek van 13:53. Twee uur
 * verschil. De transcriptregels ernaast toonden wél 13:53:38.
 *
 * Op geen van de zes plekken stond een `timeZone`. Wat het verschil maakte, was wáár de code
 * draaide: `transcript.tsx` is een clientcomponent en rendert in de browser
 * (Europe/Amsterdam), `page.tsx` is een servercomponent en rendert op Netlify (UTC).
 * `toLocaleString('nl-NL')` neemt zonder `timeZone` de zone van de omgeving.
 *
 * Dat is erger dan een verkeerde zone: dezelfde uitdrukking gaf twee antwoorden, en welke je
 * kreeg hing af van een architectuurdetail dat niets met tijd te maken heeft.
 *
 * ## Waarom een controle en niet alleen één functie
 *
 * Precies dezelfde vorm als de samplerate op drie plekken (risico 19). Daar stond de
 * waarschuwing zelfs in een toelichting boven de code die het fout deed, en het gebeurde toch.
 * Eén functie lost het op voor vandaag; deze controle houdt het vast.
 *
 * ## Waarom dit meer is dan cosmetiek
 *
 * Twee uur is bij een tijdstip een ongemak. Bij een vervaltermijn is het soms een dag: een
 * gesprek van dinsdag 00:30 staat in UTC op maandag, en dan telt een advocaat een dag verkeerd
 * op een termijn die niet verschuift.
 *
 * ## Wat deze controle níét kan
 *
 * Hij leest tekst. Hij ziet dat er geen tweede rekenwijze bijkomt, niet of de zone die wordt
 * doorgegeven de júiste is. Dat de functie zelf klopt, staat in `tijd.test.ts`.
 *
 * Draaien met: pnpm tijd:check
 */

const REPO = process.cwd();
const OVERSLAAN = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'measurements']);

/** De enige plek waar een tijdstip een tekst mag worden. */
const BRON = join('packages', 'domain', 'src', 'tijd.ts');

/** Doorzochte mappen: alles wat een gebruiker te zien krijgt. */
const GEBIED = [
  join('apps', 'web', 'src'),
  join('packages', 'ui', 'src'),
  join('packages', 'domain', 'src'),
];

/*
 * Twee patronen, en het onderscheid is nodig.
 *
 * `toLocaleDateString`, `toLocaleTimeString` en `Intl.DateTimeFormat` bestaan alleen voor
 * datums; die zijn altijd fout buiten de bron.
 *
 * `toLocaleString` niet: die staat óók op `Number`, en `arithmetic.ts` gebruikt hem om een
 * bedrag leesbaar te maken. De eerste versie van deze controle keurde dat af — een detector die
 * getallen voor tijden aanziet, wordt uitgezet. Vandaar de tweede regel: alleen aanslaan als er
 * op dezelfde regel ook iets datumachtigs staat.
 *
 * Dat is niet waterdicht. Een `toLocaleString` op een datumvariabele die `x` heet, glipt
 * erdoor. Wat het wél vangt is elke vorm die tot nu toe is voorgekomen, en dat staat hier zodat
 * niemand denkt dat het meer is.
 */
const ALTIJD_FOUT = /\.toLocale(DateString|TimeString)\s*\(|new Intl\.DateTimeFormat\s*\(/;
const MISSCHIEN_FOUT = /\.toLocaleString\s*\(/;
const DATUMACHTIG = /Date|_at|[Dd]atum|[Tt]ijd|createdAt|uploadedAt|completedAt/;

function bestanden(map, gevonden = []) {
  let inhoud;
  try {
    inhoud = readdirSync(map);
  } catch {
    return gevonden;
  }
  for (const naam of inhoud) {
    if (OVERSLAAN.has(naam) || naam.startsWith('.')) continue;
    const pad = join(map, naam);
    if (statSync(pad).isDirectory()) bestanden(pad, gevonden);
    else if (/\.tsx?$/.test(naam)) gevonden.push(pad);
  }
  return gevonden;
}

const overtreders = [];
for (const gebied of GEBIED) {
  for (const pad of bestanden(join(REPO, gebied))) {
    const relatief = relative(REPO, pad);
    // De bron mag het per definitie, en een test mag een verwachte waarde uitrekenen.
    if (relatief === BRON || /\.test\.tsx?$/.test(relatief)) continue;

    const regels = readFileSync(pad, 'utf8').split(/\r?\n/);
    regels.forEach((regel, i) => {
      // Toelichtingen tellen niet mee: die verwijzen er juist naar om uit te leggen wat er
      // misging, en een controle die zijn eigen uitleg afkeurt, wordt uitgezet.
      const kaal = regel.trim();
      if (kaal.startsWith('*') || kaal.startsWith('//') || kaal.startsWith('/*')) return;
      const fout =
        ALTIJD_FOUT.test(regel) || (MISSCHIEN_FOUT.test(regel) && DATUMACHTIG.test(regel));
      if (fout) {
        overtreders.push(`${relatief.split(sep).join('/')}:${i + 1}  ${kaal.slice(0, 90)}`);
      }
    });
  }
}

console.log('\n  Tijdweergave: rekent er iets anders een tijd uit?\n');
if (overtreders.length === 0) {
  console.log(`    ok   alles loopt via ${BRON.split(sep).join('/')}`);
  console.log('\n  Eén rekenwijze, overal doorgegeven.\n');
  process.exit(0);
}

console.log('    Deze plekken rekenen zelf een tijd uit:\n');
for (const o of overtreders) console.log(`    FOUT ${o}`);
console.log(
  '\n  Zonder `timeZone` neemt dit de zone van de omgeving — UTC op de server, de zone van\n' +
    '  de lezer in de browser. Dezelfde uitdrukking geeft dan twee antwoorden. Gebruik\n' +
    '  datumTijd / datumTijdSeconden / alleenDatum / alleenTijd uit @intake/domain, met de\n' +
    '  zone van het kantoor. Zie RISICOS.md risico 25.\n',
);
process.exit(1);
