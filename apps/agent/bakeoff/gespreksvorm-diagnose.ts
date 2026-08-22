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
 * Gemeten uitkomst: 2,8 feiten per beurt zonder narratieve fase tegen 2,6 met. Dat is
 * geen bevestiging en geen weerlegging — het is een meting die de vraag niet raakt. Wat
 * wél verschilde: nul vulwoorden tegen één.
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

    rondes.push({ beurt: i + 1, vraag: antwoord.trim(), nieuweFeiten: nieuw, totaal: gezien.size });
  }
  return rondes;
}

/** Vulwoorden die als erkenning worden gebruikt zonder ergens op te slaan. */
const VULWOORDEN = ['logisch', 'dat begrijp ik', 'goed.', 'begrijpelijk', 'helder.', 'duidelijk.'];
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
  const vulwoord = rondes.filter((r) => VULWOORDEN.some((v) => r.vraag.toLowerCase().includes(v)));
  const open = rondes.filter((r) => r.vraag.includes('?') && !GESLOTEN.test(r.vraag));
  console.log(
    `  ${totaal} feiten / ${rondes.length} beurten = ${(totaal / rondes.length).toFixed(1)} per beurt` +
      ` · vulwoorden ${vulwoord.length} · open vragen ${open.length}/${rondes.length}`,
  );
}

// Zonder narratieve fase eerst: dat is het gedrag van vóór v4, meteen de kandidatenlijst
// afwerken. Dezelfde cliëntwoorden, dezelfde volgorde — alleen de gespreksvorm verschilt.
rapport('ZONDER narratieve fase', await voerGesprek('zonder', 0));
rapport('MET narratieve fase (3 beurten)', await voerGesprek('met', 3));

process.exit(0);
