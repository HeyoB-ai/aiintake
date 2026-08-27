/**
 * Korte uitingen, en wat ze mogen.
 *
 * ## Waarom dit één tabel is
 *
 * Er waren twee lijsten met twee doelen:
 *
 *   `BACKCHANNELS_NL/EN`  mag de assistent hierdoor **niet** worden onderbroken?
 *   `INHOUDSLOOS`         kan dit woord **geen feit dragen**?
 *
 * Twee doelen, dus twee lijsten is verdedigbaar. Wat niet verdedigbaar was: dat ze per ongeluk
 * verschilden. "Inderdaad" stond alleen in de tweede — het onderbrak de assistent én werd als
 * bewijs geweigerd. "Mm-hm" stond alleen in de eerste — het onderbrak niet, maar telde wél als
 * inhoud. Dat is niemands keuze geweest, en het is precies wat je in een gesprek merkt.
 *
 * Nu één tabel met twee kolommen. Elk woord staat bewust in beide of in één van beide, en waar
 * ze verschillen staat de reden erbij. Wie een woord toevoegt, moet twee vragen beantwoorden in
 * plaats van er één te vergeten.
 *
 * ## De asymmetrie die de kolommen stuurt
 *
 * Ze zijn niet even gevaarlijk om fout te hebben.
 *
 * **Te ruim `backchannel`** maakt de assistent doof: de cliënt onderbreekt en zij praat door.
 * Dat is het ergste van de twee — een cliënt die niet tussenbeide kan komen, geeft het op.
 * Daarom staat alles wat óók het begin van een echte zin kan zijn hier op `false`: "nee", "eh",
 * "nou", "tja", "goed". Ze schelen hoogstens een halve seconde spreektijd; het omgekeerde kost
 * de cliënt zijn correctie.
 *
 * **Te ruim `inhoudsloos`** gooit echte antwoorden weg. "Nee, dat was in maart" is geen
 * inhoudsloze instemming. Vandaar dat deze kolom alleen over het hele citaat oordeelt: één woord
 * uit de lijst is niets, álle woorden uit de lijst is een citaat dat geen feit kan dragen.
 *
 * ## Wat hier níét in staat
 *
 * Stopwoorden als "dat", "is", "het". Die zijn geen korte uiting maar vulling in een citaat, en
 * ze horen alleen bij de tweede vraag. Zie `STOPWOORDEN` onderaan.
 */

export interface KorteUiting {
  readonly woord: string;
  readonly taal: 'nl' | 'en';
  /** Onderbreekt dit de assistent níét? */
  readonly backchannel: boolean;
  /** Kan dit woord geen feit dragen? */
  readonly inhoudsloos: boolean;
  /** Verplicht zodra de twee kolommen verschillen: waaróm verschillen ze. */
  readonly waarom?: string;
}

export const KORTE_UITINGEN: readonly KorteUiting[] = [
  // ---------------------------------------------------------------- instemming
  // Beide kolommen waar: het is een luistergeluid én het draagt geen feit.
  { woord: 'ja', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'jawel', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'jazeker', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'klopt', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'precies', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'juist', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'inderdaad', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'zeker', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'correct', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'yes', taal: 'en', backchannel: true, inhoudsloos: true },
  { woord: 'yeah', taal: 'en', backchannel: true, inhoudsloos: true },
  { woord: 'right', taal: 'en', backchannel: true, inhoudsloos: true },
  { woord: 'sure', taal: 'en', backchannel: true, inhoudsloos: true },
  { woord: 'exactly', taal: 'en', backchannel: true, inhoudsloos: true },

  // ---------------------------------------------------------------- luistergeluiden
  { woord: 'mm-hm', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'mmhm', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'hm', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'hmm', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'uh-huh', taal: 'en', backchannel: true, inhoudsloos: true },

  // ---------------------------------------------------------------- bevestiging van ontvangst
  { woord: 'oké', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'oke', taal: 'nl', backchannel: true, inhoudsloos: true },
  { woord: 'ok', taal: 'en', backchannel: true, inhoudsloos: true },
  { woord: 'okay', taal: 'en', backchannel: true, inhoudsloos: true },

  // ---------------------------------------------------------------- wél onderbreken
  {
    woord: 'nee',
    taal: 'nl',
    backchannel: false,
    inhoudsloos: true,
    waarom:
      'Een "nee" is een correctie. Zegt de assistent iets verkeerd, dan moet de cliënt haar ' +
      'kunnen stoppen — dat is het tegenovergestelde van een luistergeluid. Als citaat draagt ' +
      'het wél geen feit: "nee" alleen zegt niet wát er dan niet klopt.',
  },
  { woord: 'nope', taal: 'en', backchannel: false, inhoudsloos: true, waarom: 'Zie "nee".' },
  { woord: 'no', taal: 'en', backchannel: false, inhoudsloos: true, waarom: 'Zie "nee".' },
  {
    woord: 'eh',
    taal: 'nl',
    backchannel: false,
    inhoudsloos: true,
    waarom:
      'Aarzeling is de cliënt die het woord neemt, niet die bevestigt. Wie "eh…" zegt, gaat ' +
      'iets zeggen; hem dan overstemmen is precies de doofheid die we willen vermijden.',
  },
  { woord: 'ehm', taal: 'nl', backchannel: false, inhoudsloos: true, waarom: 'Zie "eh".' },
  { woord: 'uh', taal: 'en', backchannel: false, inhoudsloos: true, waarom: 'Zie "eh".' },
  { woord: 'uhm', taal: 'en', backchannel: false, inhoudsloos: true, waarom: 'Zie "eh".' },
  {
    woord: 'nou',
    taal: 'nl',
    backchannel: false,
    inhoudsloos: true,
    waarom:
      '"Nou" en "tja" gaan vrijwel altijd vooraf aan een bezwaar of een nuancering. Ze klinken ' +
      'als aarzeling maar kondigen inhoud aan.',
  },
  { woord: 'tja', taal: 'nl', backchannel: false, inhoudsloos: true, waarom: 'Zie "nou".' },
  {
    woord: 'goed',
    taal: 'nl',
    backchannel: false,
    inhoudsloos: true,
    waarom:
      '"Goed" staat even vaak aan het begin van een zin — "goed, maar toen…" — als op zichzelf. ' +
      'Bij twijfel wint hier onderbreken: te vroeg stoppen kost een halve seconde, doorpraten ' +
      'over een correctie heen kost de correctie.',
  },
];

/** De woorden die de assistent niet onderbreken, per taal. */
export function backchannelsVoor(taal: 'nl' | 'en'): readonly string[] {
  return KORTE_UITINGEN.filter((u) => u.backchannel && u.taal === taal).map((u) => u.woord);
}

/**
 * Vulling in een citaat: geen korte uiting, maar ook geen inhoud.
 *
 * Staat los van de tabel hierboven omdat deze woorden nooit op zichzelf worden gezegd. Ze
 * bestaan alleen om te beoordelen of een héél citaat leeg is: "dat was het" is drie woorden en
 * nul feiten.
 */
export const STOPWOORDEN: readonly string[] = ['dat', 'is', 'het', 'was', 'die', 'dit'];

/** Alles wat in een citaat geen feit kan dragen: de tabel plus de stopwoorden. */
export const INHOUDSLOZE_WOORDEN: ReadonlySet<string> = new Set([
  ...KORTE_UITINGEN.filter((u) => u.inhoudsloos).map((u) => u.woord),
  ...STOPWOORDEN,
]);
