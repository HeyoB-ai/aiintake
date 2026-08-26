import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Spreekt de hele keten dezelfde samplerate?
 *
 * ## Wat er misging
 *
 * Op 26 augustus 2026 ging de TTS van 16 naar 24 kHz. Drie andere plekken bleven op 16000
 * staan, allemaal als eigen kopie van hetzelfde getal:
 *
 *   live/server.ts       `const SAMPLE_RATE = 16_000`, meegestuurd in het `ready`-bericht
 *   live/page.html       `const SR = 16000`, gebruikt in `createBuffer()`
 *   null-provider.ts     `new NullAvatarSession(16_000, …)`, met de opties genegeerd
 *
 * Er viel niets om. Alle drie de getallen zijn geldig, geen enkele controle raakte eraan, en
 * er kwam gewoon geluid uit de speakers. Alleen anderhalf keer te traag, met een te lage
 * toonhoogte — wat van buiten klinkt als een stem die langzaam praat. En `bufferedMs` kwam er
 * anderhalf keer te hoog uit, waardoor het transcript meer als gehoord vastlegde dan er klonk.
 *
 * Boven het `ready`-bericht stond op dat moment al, letterlijk: "twee plekken met hetzelfde
 * getal is hoe een mismatch ontstaat, en een mismatch klinkt hier als spraak die te snel of te
 * traag loopt." Die waarschuwing stond er en het gebeurde toch, want het getal dat werd
 * meegestuurd was zélf de tweede kopie. Een toelichting is geen bewaker.
 *
 * ## Wat deze controle wel kan
 *
 * De kant die geen unittest heeft: de browserpagina en de bedrading eromheen. Hij kijkt of het
 * getal ergens opnieuw wordt opgeschreven in plaats van doorgegeven.
 *
 * ## Wat deze controle níét kan
 *
 * Hij leest tekst en voert niets uit. Hij ziet dus niet of de rate die wordt doorgegeven ook
 * de juiste ís — alleen dat er geen tweede bron voor in de plaats is gekomen. Dat de sessie
 * met de meegegeven rate rékent, staat in `null-provider.test.ts`; dat de synthese levert wat
 * ze belooft, in `pnpm diag:tts-productieweg`. Deze drie dekken samen de keten; los dekt geen
 * van drieën hem.
 *
 * Draaien met: pnpm samplerate:check
 */

const REPO = process.cwd();
const lees = (...p) => readFileSync(join(REPO, ...p), 'utf8');

const klachten = [];
const gerust = [];

function eis(voorwaarde, klacht, gerustelling) {
  if (voorwaarde) gerust.push(gerustelling);
  else klachten.push(klacht);
}

// ---------------------------------------------------------------- de bron
const fabriek = lees('apps', 'agent', 'src', 'tts-fabriek.ts');
const bron = /export const TTS_SAMPLE_RATE = ([\d_]+);/.exec(fabriek);
eis(
  bron !== null,
  'tts-fabriek.ts: TTS_SAMPLE_RATE niet gevonden. Dit is de enige plek waar de rate hoort ' +
    'te staan; staat hij er niet meer, dan weet deze controle niet waartegen hij vergelijkt.',
  `de bron staat in tts-fabriek.ts: ${bron?.[1] ?? '?'} Hz`,
);

// ---------------------------------------------------------------- de worker
const server = lees('apps', 'agent', 'live', 'server.ts');
/*
 * Hier stond: "SAMPLE_RATE moet een afgeleide van media.tts.sampleRate zijn".
 *
 * Die eis bevestigde de fout in plaats van hem te vangen. Een module-constante is óók een
 * tweede plek waar dit getal woont — hij bevriest bij het laden van de module wat per sessie
 * hoort te worden bepaald, en een kantoor met een andere leverancier krijgt hem niet mee.
 *
 * Bovendien crashte die vorm: de constante stond boven `const media` en draaide dus bij het
 * importeren, voordat `media` bestond. Op Railway kwam dat eruit als "Cannot read properties
 * of undefined (reading 'tts')", bij elke herstart.
 *
 * De eis is dus omgekeerd: er hoort hier géén constante te zijn.
 */
eis(
  !/^const SAMPLE_RATE/m.test(server),
  'live/server.ts: er staat weer een SAMPLE_RATE op moduleniveau. Ook een afgeleide is een ' +
    'tweede plek: hij bevriest bij het laden wat per sessie hoort te worden bepaald. Vraag ' +
    'de rate aan de mediaketen van de sessie.',
  'server.ts heeft geen samplerate op moduleniveau',
);
eis(
  /sampleRate: mediaketen\.tts\.sampleRate,/.test(server),
  'live/server.ts: het `ready`-bericht meldt niet mediaketen.tts.sampleRate. Juist dáár ging ' +
    'het mis: er werd een rate meegestuurd, maar het was een tweede kopie.',
  'het ready-bericht meldt de rate van de sessie zelf',
);

// ---------------------------------------------------------------- de pagina
const pagina = lees('apps', 'agent', 'live', 'page.html');
eis(
  /createBuffer\(1, int16\.length, SR_UIT\)/.test(pagina),
  'live/page.html: createBuffer() krijgt de afspeelrate niet uit SR_UIT. Een getal hier ' +
    'verklaart de samples verkeerd, en dan speelt alles op de verkeerde snelheid af.',
  'de pagina verklaart de audio met de rate die de server meldde',
);
eis(
  /let SR_UIT = null;/.test(pagina),
  'live/page.html: SR_UIT heeft weer een beginwaarde. Juist die stille terugval maakte de ' +
    'mismatch onhoorbaar als fout: er kwam geluid uit, alleen te traag.',
  'de pagina heeft geen terugvalrate en meldt het als hij hem niet weet',
);
eis(
  /ctxUit = new AudioContext\(\);/.test(pagina),
  'live/page.html: de uitvoercontext krijgt een opgelegde rate. Dat dwingt de browser alles ' +
    'daarheen terug te rekenen en gooit de winst van een hogere rate weg.',
  'de uitvoercontext laat de browser zijn eigen rate kiezen',
);

// ---------------------------------------------------------------- de avatarlaag
const nul = lees('packages', 'providers', 'avatar', 'src', 'null-provider.ts');
eis(
  /new NullAvatarSession\(options\.sampleRate, this\.now\)/.test(nul),
  'null-provider.ts: createSession() gebruikt options.sampleRate niet. Met een eigen getal ' +
    'rekent bufferedMs verkeerd, en dat is de bovengrens van wat het transcript als gehoord ' +
    'vastlegt.',
  'de null-avatar rekent met de rate die hij meekrijgt',
);
const contract = lees('packages', 'providers', 'avatar', 'src', 'contract.ts');
eis(
  /readonly sampleRate: number;/.test(contract),
  'avatar/contract.ts: sampleRate is geen verplicht veld meer op AvatarSessionOptions. ' +
    'Optioneel met een terugval is precies de vorm waarin dit stil kan misgaan.',
  'sampleRate is verplicht in het avatarcontract',
);

// ---------------------------------------------------------------- uitkomst
console.log('\n  Samplerate: spreekt de keten zichzelf tegen?\n');
for (const g of gerust) console.log(`    ok   ${g}`);
if (klachten.length === 0) {
  console.log('\n  Eén bron, overal doorgegeven.\n');
  process.exit(0);
}
console.log('');
for (const k of klachten) console.log(`    FOUT ${k}\n`);
console.log(`  ${klachten.length} plek(ken) met een eigen samplerate.\n`);
process.exit(1);
