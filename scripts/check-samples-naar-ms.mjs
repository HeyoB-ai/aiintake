import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Wie rekent er samples om naar milliseconden, en rondt hij af?
 *
 * ## Waarom dit bestaat
 *
 * `(pcm.length / rate) * 1000` staat op negen plekken. Dat is de grootvader van de fout die op
 * 27 augustus 2026 twee keer de openingsbeurt kostte: `spoken_ms` is een `int`, de uitkomst was
 * `20702.458333333336`, en de insert werd geweigerd.
 *
 * Wat die fout zo lastig maakte om aan te zien komen: er zijn vier wegen naar `spokenMs`, en
 * **drie deden het al goed**. `cancel()` in beide TTS-adapters en `interrupt()` in de
 * null-avatar rondden af; alleen de schone beurt niet. Vanaf elke gezonde weg zag het er
 * correct uit.
 *
 * ## Wat deze controle doet
 *
 * Hij telt de plekken die zelf samples naar milliseconden omrekenen, en meldt ze. Niet als
 * fout — die rekensom hóórt in een adapter te staan, want die kent zijn eigen chunkvorm. Wel
 * als lijst, met de eis dat het aantal bekend is.
 *
 * Komt er een tiende bij, dan faalt dit met de nieuwe plek erbij en de vraag: rondt hij af
 * waar de waarde ontstaat, of pas vlak voor de database? Dat tweede verbergt dat de grootheid
 * zelf misschien niet klopt.
 *
 * ## Waarom niet gewoon één functie
 *
 * Dat is overwogen en het lost minder op dan het lijkt. De negen plekken rekenen met
 * verschillende rates, verschillende chunkvormen en verschillende bedoelingen — een gedeelde
 * `msVanSamples()` maakt van negen regels negen aanroepen en verplaatst de vraag "en wordt hij
 * afgerond?" naar de aanroeper. Het risico zit niet in de deling maar in wat er daarna met de
 * uitkomst gebeurt, en dat is per plek anders.
 *
 * Wat wél helpt is dat niemand er ongemerkt een bij zet. Vandaar een teller.
 *
 * Draaien met: pnpm samples:check
 */

const REPO = process.cwd();
/*
 * `bakeoff` en `vendor-check` staan er bewust buiten.
 *
 * Dat zijn diagnostische proeven die audio-rekenwerk met opzet zelf uitschrijven — het hele
 * punt van `diag:audio` is dat hij náást de adapter meet en niet erdoorheen. Ze meetellen zou
 * deze controle laten afgaan op precies het gereedschap dat de fouten vindt.
 */
const OVERSLAAN = new Set([
  'node_modules',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  'measurements',
  'bakeoff',
  'vendor-check',
]);
const GEBIED = [join('apps', 'agent'), join('packages')];

/*
 * De vormen die voorkomen. Allemaal "aantal samples gedeeld door een rate, maal duizend",
 * met of zonder haakjes en met wisselende namen.
 */
const PATRONEN = [
  // `x / <iets>.sampleRate * 1000` en `x / SAMPLE_RATE * 1000`, met of zonder haakjes.
  /\/\s*(?:this\.)?(?:config|options)?\.?\s*(?:SAMPLE_RATE|sampleRate|rate|RATE|bronRate)\s*\)?\s*\*\s*1000/,
  /\*\s*1000\s*\)?\s*\/\s*(?:SAMPLE_RATE|sampleRate|rate)/,
];

/**
 * Het aantal plekken dat we kennen en hebben nagelopen.
 *
 * Bewust een getal en geen lijst met paden: een lijst moedigt aan om er stilletjes een pad aan
 * toe te voegen. Een teller die omhoog moet, dwingt een moment van "en rondt die af?".
 */
const BEKEND = 9;

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
    else if (/\.tsx?$/.test(naam) && !/\.test\.tsx?$/.test(naam)) gevonden.push(pad);
  }
  return gevonden;
}

const plekken = [];
for (const gebied of GEBIED) {
  for (const pad of bestanden(join(REPO, gebied))) {
    const relatief = relative(REPO, pad).split(sep).join('/');
    readFileSync(pad, 'utf8')
      .split(/\r?\n/)
      .forEach((regel, i) => {
        const kaal = regel.trim();
        if (kaal.startsWith('*') || kaal.startsWith('//') || kaal.startsWith('/*')) return;
        if (PATRONEN.some((p) => p.test(regel))) {
          plekken.push(`${relatief}:${i + 1}  ${kaal.slice(0, 80)}`);
        }
      });
  }
}

console.log('\n  Samples naar milliseconden: hoeveel plekken rekenen dit zelf uit?\n');
for (const p of plekken) console.log(`    ${p}`);
console.log(`\n  ${plekken.length} plek(ken); bekend en nagelopen: ${BEKEND}.`);

if (plekken.length === BEKEND) {
  console.log('  Geen nieuwe.\n');
  process.exit(0);
}

console.log(
  plekken.length > BEKEND
    ? '\n  ER IS ER EEN BIJGEKOMEN. Rondt hij af wáár de waarde ontstaat, of pas vlak voor de\n' +
        '  database? Dat tweede verbergt dat de grootheid zelf misschien niet klopt — zie\n' +
        '  RISICOS.md risico 26. Klopt het: zet BEKEND hierboven op het nieuwe aantal.\n'
    : '\n  ER ZIJN ER MINDER GEWORDEN. Mooi — zet BEKEND hierboven op het nieuwe aantal, zodat\n' +
        '  de volgende toevoeging weer opvalt.\n',
);
process.exit(1);
