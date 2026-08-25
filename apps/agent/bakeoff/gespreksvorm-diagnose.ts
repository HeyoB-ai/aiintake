import { AnthropicLlmProvider } from '@intake/provider-llm';
import type { OrgConfig } from '@intake/domain';
import { IntakeSession } from '../src/intake-session';

/**
 * De gespreksvorm meten.
 *
 * ## Wat dit harnas wél doet
 *
 * Het telt per beurt hoeveel nieuwe feiten er binnenkomen, hoeveel vulwoorden er als
 * erkenning worden gebruikt, en hoeveel vragen open zijn. Twee gesprekken naast elkaar,
 * met dezelfde cliëntwoorden in dezelfde volgorde; alleen de narratieve fase verschilt.
 *
 * ## Wat het NIET kan, en dat is belangrijker
 *
 * De aanname achter "open vragen leveren meer feiten op" is dat ze de cliënt méér laten
 * vertellen. Deze opzet gebruikt een gescripte cliënt die op elke vraag hetzelfde
 * antwoordt. Daarmee ligt de hoeveelheid inhoud vast en kán een open vraag per definitie
 * niet meer opleveren.
 *
 * Dit meet dus hoeveel de assistent uit een gegeven hoeveelheid woorden haalt, en niet
 * hoeveel woorden hij losmaakt. Precies de vraag die ertoe doet, valt erbuiten.
 *
 * Gemeten uitkomst (v7): 2,8 feiten per beurt, met én zonder narratieve fase. Dat is geen
 * bevestiging en geen weerlegging — het is een meting die de vraag niet raakt.
 *
 * Wat er wél uit kwam, en dat was de opbrengst van deze run: de vulwoordteller stond op
 * een woordenlijst van zes uitdrukkingen en meldde nul, terwijl er "Dank u.", "Begrepen."
 * en "Dat is duidelijk." in het transcript stonden. Nu telt hij volgens de regel uit de
 * prompt — een korte aanloopzin die geen inhoudswoord deelt met wat de cliënt zojuist zei
 * — en noemt hij wat hij vindt, zodat een nul te controleren is in plaats van te
 * geloven. Dat leverde v7 op: bedanken staat nu expliciet in de verboden lijst.
 *
 * Om de aanname echt te toetsen zou de cliënt op de vraagstijl moeten reageren, en dan
 * meet je de bereidwilligheid van het cliëntmodel. Het eerlijke oordeel komt uit een
 * echte sessie; dit harnas bewaakt ondertussen de dingen die wél telbaar zijn.
 *
 * Draaien met: pnpm diag:gespreksvorm
 */

const ORG = { id: 'o', name: 'Kantoor De Vries', slug: 'devries' } as OrgConfig;

/**
 * Wat de cliënt vertelt, in stukken zoals iemand dat werkelijk doet: eerst het verhaal,
 * daarna de details. Elke beurt komt sowieso, ongeacht de vraag.
 */
const CLIENT = [
  'Ik ben vorige week op staande voet ontslagen bij Acme Nederland. Het ging over een ' +
    'discussie met mijn leidinggevende over een project dat mislukt was.',
  'Ik werk daar sinds maart 2019 als projectleider, achtendertig uur per week. Ik verdien ' +
    'ongeveer 4200 euro bruto per maand.',
  'Ze hebben me een brief gegeven waarin staat dat ik onmiddellijk weg moest. Ik heb er ' +
    'nog niet op gereageerd, want ik wist niet wat ik moest doen.',
  'Ik was in februari een paar weken ziek geweest, en ik denk dat dat meespeelde. De ' +
    'bedrijfsarts was er ook bij betrokken.',
  'Ik wil eigenlijk gewoon een fatsoenlijke regeling. Terug wil ik niet meer.',
];

interface Ronde {
  beurt: number;
  vraag: string;
  /** Wat de cliënt zei vóór deze beurt; nodig om erkenning van vulwoord te onderscheiden. */
  clientZei: string;
  nieuweFeiten: string[];
  totaal: number;
}

async function voerGesprek(label: string, narrativeTurns: number): Promise<Ronde[]> {
  const sessie = new IntakeSession({
    llm: new AnthropicLlmProvider({ apiKey: process.env['ANTHROPIC_API_KEY']! }),
    organization: ORG,
    hotModel: process.env['LLM_HOT_MODEL'] ?? 'claude-haiku-4-5-20251001',
    coldModel:
      process.env['LLM_COLD_MODEL'] ?? process.env['LLM_HOT_MODEL'] ?? 'claude-haiku-4-5-20251001',
    now: () => new Date('2026-08-22T10:00:00Z'),
    narrativeTurns,
  });

  const bron = sessie.responseSource();
  const rondes: Ronde[] = [];
  const gezien = new Set<string>();

  // De openingsbeurt: de assistent begint, de cliënt heeft nog niets gezegd.
  let vraag = '';
  {
    const c = new AbortController();
    for await (const stuk of bron({ utterance: '' }, c.signal)) vraag += stuk;
    sessie.recordTurn('', vraag);
  }
  console.log(`\n  [${label}] opening: ${vraag.trim()}`);

  for (const [i, zin] of CLIENT.entries()) {
    // Extractie vóór de volgende beurt, zodat de planner de feiten van deze beurt heeft.
    // Zo werkt productie niet — daar loopt het parallel en loopt de planner achter — maar
    // hier meten we de gespreksvorm en niet de vertraging.
    const antwoord = await (async () => {
      const c = new AbortController();
      let t = '';
      for await (const stuk of bron({ utterance: zin }, c.signal)) t += stuk;
      return t;
    })();

    sessie.recordTurn(zin, antwoord);
    const r = await sessie.observe();

    const nieuw = r.factUpdates.map((f) => f.key).filter((k) => !gezien.has(k));
    for (const k of nieuw) gezien.add(k);

    rondes.push({
      beurt: i + 1,
      vraag: antwoord.trim(),
      clientZei: zin,
      nieuweFeiten: nieuw,
      totaal: gezien.size,
    });
  }
  return rondes;
}

/*
 * Een vulwoord herkennen aan de regel, niet aan een woordenlijst.
 *
 * Hier stond een lijst van zes uitdrukkingen. Die telde nul vulwoorden in een gesprek waar
 * "Dank u.", "Begrepen.", "Dat is duidelijk." en "Dat helpt." gewoon in stonden — de
 * meting las schoon omdat haar vocabulaire te klein was. De lijst uitbreiden tot hij
 * matcht met wat ik toevallig zag, is die fout herhalen met meer woorden.
 *
 * De prompt zegt wat de regel is: erkennen mag, maar dan specifiek en **met de woorden van
 * de cliënt**. Dus: een korte zin vóór de vraag die geen enkel inhoudswoord deelt met wat
 * de cliënt zojuist zei, is een vulwoord. Dat is de regel zelf, en hij vangt ook
 * formuleringen die niemand heeft voorzien.
 */
const STOPWOORDEN = new Set([
  'de',
  'het',
  'een',
  'en',
  'of',
  'maar',
  'dat',
  'die',
  'dit',
  'deze',
  'ik',
  'u',
  'uw',
  'mijn',
  'me',
  'mij',
  'is',
  'was',
  'ben',
  'bent',
  'zijn',
  'heb',
  'heeft',
  'had',
  'hebben',
  'er',
  'ook',
  'niet',
  'geen',
  'wel',
  'te',
  'van',
  'voor',
  'met',
  'op',
  'in',
  'aan',
  'bij',
  'naar',
  'om',
  'over',
  'als',
  'dan',
  'nog',
  'toen',
  'wat',
  'wie',
  'waar',
  'hoe',
  'waarom',
  'kunt',
  'kan',
  'zou',
  'moet',
  'wil',
  'ja',
  'nee',
  'even',
  'heel',
]);

function inhoudswoorden(tekst: string): Set<string> {
  return new Set(
    tekst
      .toLowerCase()
      .replace(/[^a-zà-ü\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWOORDEN.has(w)),
  );
}

/**
 * De aanloopzin vóór de eerste vraag, als die er is.
 *
 * Alleen korte zinnen tellen: een volledige zin die iets naspreekt is inhoud, geen
 * opvulling.
 */
function aanloopzin(beurt: string): string | null {
  const eerste = beurt.split(/(?<=[.!?])\s+/)[0]?.trim() ?? '';
  if (eerste === '' || eerste.includes('?')) return null;
  if (eerste.split(/\s+/).length > 6) return null;
  return eerste;
}

function isVulwoord(ronde: Ronde): boolean {
  const aanloop = aanloopzin(ronde.vraag);
  if (aanloop === null) return false;
  const gedeeld = inhoudswoorden(aanloop);
  const vanClient = inhoudswoorden(ronde.clientZei);
  for (const w of gedeeld) if (vanClient.has(w)) return false;
  return true;
}
/** Een vraag die met een werkwoord opent, vraagt om ja of nee. */
const GESLOTEN = /^(is|was|heeft|bent|had|klopt|zijn|kunt u bevestigen|deed)/i;

function rapport(label: string, rondes: readonly Ronde[]): void {
  console.log(`\n  ${label}`);
  console.log(`  ${'beurt'.padEnd(7)}${'nieuw'.padEnd(7)}${'totaal'.padEnd(9)}vraag`);
  for (const r of rondes) {
    console.log(
      `  ${String(r.beurt).padEnd(7)}${String(r.nieuweFeiten.length).padEnd(7)}` +
        `${String(r.totaal).padEnd(9)}${r.vraag.replace(/\s+/g, ' ').slice(0, 68)}`,
    );
  }
  const totaal = rondes.at(-1)?.totaal ?? 0;
  const vulwoord = rondes.filter(isVulwoord);
  const open = rondes.filter((r) => r.vraag.includes('?') && !GESLOTEN.test(r.vraag));
  console.log(
    `  ${totaal} feiten / ${rondes.length} beurten = ${(totaal / rondes.length).toFixed(1)} per beurt` +
      ` · vulwoorden ${vulwoord.length} · open vragen ${open.length}/${rondes.length}`,
  );
  // De gevonden vulwoorden erbij, zodat een cijfer van nul te controleren is en niet
  // alleen te geloven.
  for (const r of vulwoord) {
    console.log(`    beurt ${r.beurt} opent met "${aanloopzin(r.vraag)}"`);
  }
}

// Zonder narratieve fase eerst: dat is het gedrag van vóór v4, meteen de kandidatenlijst
// afwerken. Dezelfde cliëntwoorden, dezelfde volgorde — alleen de gespreksvorm verschilt.
rapport('ZONDER narratieve fase', await voerGesprek('zonder', 0));
rapport('MET narratieve fase (3 beurten)', await voerGesprek('met', 3));

process.exit(0);
