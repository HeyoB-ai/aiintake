import type { Language } from './enums';

/**
 * De erkenning: één korte zin vóór de volgende vraag, als de cliënt iets zwaars zei.
 *
 * ## Waarom dit bestaat
 *
 * Iemand vertelt dat hij op staande voet is ontslagen en de assistent stelt meteen de
 * volgende vraag. Een mens zou eerst iets zeggen. Dat gat is geen promptfout maar een
 * ontwerpkeuze die niemand bewust heeft gemaakt: de planner is deterministisch en weegt de
 * lading van de vorige uitspraak nergens, dus correctheid won het van menselijkheid zonder
 * dat er een afweging aan te pas kwam.
 *
 * ## Waarom de wóórden hier staan en niet uit het model komen
 *
 * Het model beoordeelt of er lading is. De zin die daarop volgt komt uit deze lijst. Die
 * scheiding is de handhaving van de eerste grens: een vaste zin kan onmogelijk de
 * juridische merites erkennen. Zou het model de erkenning formuleren, dan is "dat klinkt
 * als onterecht ontslag" één ongelukkige generatie ver weg — en dat is juridisch advies,
 * precies wat het toestemmingsscherm belooft niet te doen.
 *
 * ## De drie grenzen, en hoe ze worden afgedwongen
 *
 * 1. **Nooit de juridische merites erkennen.** Afgedwongen door de vaste lijst hieronder.
 *    Geen enkele zin bevat een oordeel over de zaak; ze gaan allemaal over de ervaring.
 * 2. **Nooit als bron voor feitextractie tellen.** Afgedwongen bij het wegschrijven: een
 *    erkenning is een assistent-beurt, en die zijn al uitgesloten. Zie de opmerking bij
 *    `ERKENNING_MARKERING`.
 * 3. **Nooit een gevoel benoemen dat de cliënt niet heeft geuit.** Afgedwongen door de
 *    zinnen zelf: geen enkele noemt een emotie van de cliënt. "Dat is ingrijpend" gaat over
 *    de gebeurtenis, "dat moet u boos hebben gemaakt" over een aanname — en die tweede
 *    vorm staat er dus niet in.
 *
 * ## Waarom herhaling verboden is
 *
 * Drie keer "wat vervelend om te horen" is erger dan zwijgen: dan hoor je de machine. Elke
 * zin wordt hoogstens één keer per gesprek gebruikt, en er zitten minstens een paar beurten
 * tussen twee erkenningen.
 */

/** Hoe zwaar de laatste uitspraak van de cliënt was. */
export type Lading = 'geen' | 'persoonlijk' | 'zwaar';

/**
 * Zinnen bij `persoonlijk`: iets wat iemand raakt, zonder dat het een klap is.
 *
 * Kort, en zonder de zaak te beoordelen. Ze mogen ook nooit een vervolgvraag bevatten —
 * de vraag komt van de planner, en twee vragen in één beurt is precies wat de gespreksvorm
 * verbiedt.
 */
const PERSOONLIJK_NL = [
  'Dat is vervelend om te horen.',
  'Dat klinkt niet prettig.',
  'Dat is een naar verhaal.',
] as const;

/**
 * Zinnen bij `zwaar`: ontslag op staande voet, ziekte, een overlijden, geldnood.
 *
 * Nadrukkelijker, en nog steeds zonder oordeel over de zaak en zonder een gevoel te
 * benoemen. "Dat is schrikken" gaat over de gebeurtenis; het zegt niet dat de cliënt
 * geschrokken ís.
 */
const ZWAAR_NL = [
  'Dat is schrikken.',
  'Dat is ingrijpend.',
  'Dat is een zware boodschap geweest.',
] as const;

const PERSOONLIJK_EN = [
  'That is unpleasant to hear.',
  'That does not sound easy.',
  'That is a difficult story.',
] as const;

const ZWAAR_EN = [
  'That is a shock.',
  'That is far-reaching.',
  'That must have been hard news to get.',
] as const;

/**
 * Hoeveel beurten er minstens tussen twee erkenningen zitten.
 *
 * Twee. Bij elke beurt erkennen klinkt als een chatbot die zijn empathiemodule afdraait;
 * na elke twee beurten is het opnieuw opvallend. Dit getal is een keuze en geen meting —
 * als het live te vaak of te weinig voelt, is dit de knop.
 */
export const MIN_BEURTEN_TUSSEN_ERKENNINGEN = 2;

/**
 * De markering waarmee een erkenning in het transcript herkenbaar blijft.
 *
 * Grens 2 uit de kop: een erkenning mag nooit als bron voor feitextractie tellen.
 * Assistent-beurten zijn daar al van uitgesloten, maar dit is een nieuwe spreekhandeling en
 * de uitsluiting hoort expliciet te zijn — anders bevestigt de assistent iets en citeert
 * het systeem dat later als grondslag.
 *
 * De extractie krijgt het transcript met dit voorvoegsel eraf gestript én de beurt als
 * `assistant` gemarkeerd. Twee sloten op één deur, met opzet: het eerste is leesbaar voor
 * een mens die het transcript nakijkt, het tweede werkt ook als iemand het voorvoegsel ooit
 * weghaalt.
 */
export const ERKENNING_MARKERING = '[erkenning] ';

export interface ErkenningStand {
  /** Zinnen die deze sessie al gebruikt zijn. */
  readonly gebruikt: readonly string[];
  /** Bij welke beurt de vorige erkenning viel; `null` als er nog geen was. */
  readonly laatsteBeurt: number | null;
}

export interface ErkenningKeuze {
  readonly zin: string | null;
  /** Waarom er niets is gekozen. Alleen gevuld als `zin` null is. */
  readonly reden?: 'geen lading' | 'te snel na de vorige' | 'zinnen op';
}

/**
 * Kiest de zin, of besluit te zwijgen.
 *
 * Volledig deterministisch: dezelfde stand en dezelfde lading geven altijd dezelfde
 * uitkomst. Het model bepaalt alleen de lading, en dat oordeel komt hier binnen als
 * parameter — er wordt hier niets aan een model gevraagd.
 */
export function kiesErkenning(
  lading: Lading,
  beurtIndex: number,
  stand: ErkenningStand,
  language: Language = 'nl',
): ErkenningKeuze {
  if (lading === 'geen') return { zin: null, reden: 'geen lading' };

  if (
    stand.laatsteBeurt !== null &&
    beurtIndex - stand.laatsteBeurt < MIN_BEURTEN_TUSSEN_ERKENNINGEN
  ) {
    return { zin: null, reden: 'te snel na de vorige' };
  }

  const lijst =
    language === 'en'
      ? lading === 'zwaar'
        ? ZWAAR_EN
        : PERSOONLIJK_EN
      : lading === 'zwaar'
        ? ZWAAR_NL
        : PERSOONLIJK_NL;

  // De eerste die nog niet gebruikt is. Op volgorde en niet willekeurig: een gesprek hoort
  // reproduceerbaar te zijn als je het transcript naleest.
  const zin = lijst.find((k) => !stand.gebruikt.includes(k));
  return zin ? { zin } : { zin: null, reden: 'zinnen op' };
}

/** Alle zinnen, zodat een test kan controleren dat er geen oordeel of gevoel in staat. */
export const ALLE_ERKENNINGEN: readonly string[] = [
  ...PERSOONLIJK_NL,
  ...ZWAAR_NL,
  ...PERSOONLIJK_EN,
  ...ZWAAR_EN,
];
