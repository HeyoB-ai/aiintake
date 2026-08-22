/**
 * Rekenkundige beweringen van de cliënt herkennen en natrekken.
 *
 * ## Waarom dit bestaat
 *
 * Live zei een cliënt: "12 x 12000 is 140000." De assistent antwoordde "Ja, dat klopt",
 * en de extractie legde 140.000 vast als `vso_severance_offered` met status `confirmed`
 * en confidence 0,85. Een verkeerd bedrag ging als vastgesteld feit het dossier in, met
 * een letterlijk citaat als onderbouwing — de citaatverankering vond het immers netjes
 * terug in het transcript.
 *
 * Dat is de gevaarlijkste vorm van fout in dit product: hij ziet er identiek uit als een
 * goede. De advocaat leest een bedrag met bronvermelding en heeft geen enkele aanleiding
 * om te twijfelen.
 *
 * ## Waarom deterministisch en niet via de prompt
 *
 * Het model instrueren om niet te bevestigen helpt, maar het is een verzoek. Twaalf maal
 * twaalfduizend is honderdvierenveertigduizend, ongeacht wat een model ervan vindt. Dit
 * is precies het soort regel dat in code hoort, om dezelfde reden als de urgentieregels:
 * gegeven dezelfde invoer volgt hetzelfde oordeel, en het is achteraf uit te leggen.
 *
 * ## Wat dit niet is
 *
 * Geen rekenmachine voor de cliënt en geen controle op alles wat op een som lijkt. Het
 * herkent één patroon — twee getallen, een operator, een uitkomst — en zegt of die
 * uitkomst klopt. Herkent het niets, dan is er niets aan de hand en gebeurt er niets.
 */

export type ArithmeticOperator = '*' | '+' | '-';

export interface ArithmeticClaim {
  /** De letterlijke tekst van de bewering, zoals de cliënt hem uitsprak. */
  readonly text: string;
  readonly left: number;
  readonly operator: ArithmeticOperator;
  readonly right: number;
  /** Wat de cliënt als uitkomst noemde. */
  readonly stated: number;
  /** Wat er werkelijk uitkomt. */
  readonly actual: number;
  readonly correct: boolean;
}

/**
 * Nederlandse getalnotatie ontleden.
 *
 * Punt is duizendtal, komma is decimaal: "12.000" is twaalfduizend en "12,5" is twaalf
 * en een half. Andersom lezen — de Engelse conventie — zou van 12.000 twaalf maken, en
 * dan controleer je een som die niemand heeft uitgesproken.
 */
export function parseDutchNumber(raw: string): number | null {
  const schoon = raw.trim().replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(schoon)) return null;

  const komma = schoon.lastIndexOf(',');
  if (komma >= 0) {
    const geheel = schoon.slice(0, komma).replace(/\./g, '');
    const decimaal = schoon.slice(komma + 1);
    const waarde = Number(`${geheel}.${decimaal}`);
    return Number.isFinite(waarde) ? waarde : null;
  }

  // Alleen punten. Als duizendtalscheiding zijn ze groepen van drie; is dat niet zo,
  // dan is het geen getal dat wij willen interpreteren en laten we het staan.
  if (schoon.includes('.')) {
    const delen = schoon.split('.');
    const groepenKloppen = delen.slice(1).every((d) => d.length === 3);
    if (!groepenKloppen) return null;
    const waarde = Number(delen.join(''));
    return Number.isFinite(waarde) ? waarde : null;
  }

  const waarde = Number(schoon);
  return Number.isFinite(waarde) ? waarde : null;
}

// Een getal mag niet op een scheidingsteken eindigen. Zonder die eis slokt de match de
// punt aan het einde van de zin op — "is 140000." — en dan valt de hele bewering weg,
// precies bij de zin uit de live-sessie.
const GETAL = String.raw`\d(?:[\d.,]*\d)?`;
const MAAL = String.raw`(?:x|\*|×|keer|maal)`;
const PLUS = String.raw`(?:\+|plus)`;
const MIN = String.raw`(?:-|min)`;
const IS = String.raw`(?:is|=|maakt|wordt|dus|komt\s+(?:neer\s+)?op|bij\s+elkaar)`;

const PATRONEN: readonly { regex: RegExp; operator: ArithmeticOperator }[] = [
  {
    regex: new RegExp(`(${GETAL})\\s*${MAAL}\\s*(${GETAL})\\s*,?\\s*${IS}\\s*(${GETAL})`, 'i'),
    operator: '*',
  },
  {
    regex: new RegExp(`(${GETAL})\\s*${PLUS}\\s*(${GETAL})\\s*,?\\s*${IS}\\s*(${GETAL})`, 'i'),
    operator: '+',
  },
  {
    regex: new RegExp(`(${GETAL})\\s*${MIN}\\s*(${GETAL})\\s*,?\\s*${IS}\\s*(${GETAL})`, 'i'),
    operator: '-',
  },
];

/** Zoekt één rekenkundige bewering in de tekst. Vindt hij er geen, dan `null`. */
export function findArithmeticClaim(text: string): ArithmeticClaim | null {
  for (const { regex, operator } of PATRONEN) {
    const treffer = regex.exec(text);
    if (!treffer) continue;

    const left = parseDutchNumber(treffer[1] ?? '');
    const right = parseDutchNumber(treffer[2] ?? '');
    const stated = parseDutchNumber(treffer[3] ?? '');
    if (left === null || right === null || stated === null) continue;

    const actual = operator === '*' ? left * right : operator === '+' ? left + right : left - right;

    // Afronding: bij euro's is een cent verschil geen rekenfout maar een afronding.
    // Groter dan een cent én groter dan een miljoenste van de uitkomst is het wel.
    const marge = Math.max(0.01, Math.abs(actual) * 1e-6);

    return {
      text: treffer[0] ?? '',
      left,
      operator,
      right,
      stated,
      actual,
      correct: Math.abs(actual - stated) <= marge,
    };
  }
  return null;
}

/** Leesbare weergave voor in een prompt of een melding. */
export function describeClaim(claim: ArithmeticClaim, language: 'nl' | 'en' = 'nl'): string {
  const teken = claim.operator === '*' ? '×' : claim.operator;
  const nl = language === 'nl';
  const getal = (n: number) => n.toLocaleString(nl ? 'nl-NL' : 'en-GB');
  return nl
    ? `${getal(claim.left)} ${teken} ${getal(claim.right)} is ${getal(claim.actual)}, niet ${getal(claim.stated)}`
    : `${getal(claim.left)} ${teken} ${getal(claim.right)} is ${getal(claim.actual)}, not ${getal(claim.stated)}`;
}
