/**
 * Instemmingen zonder inhoud herkennen.
 *
 * ## Waarom
 *
 * De verankering controleert of een citaat van de cliënt komt. Dat is nodig maar niet
 * genoeg: "Ja." komt óók van de cliënt, en draagt geen datum, geen bedrag en geen naam.
 * Het bevestigt hooguit iets wat een ánder heeft gezegd.
 *
 * Zonder deze regel is de reparatie van het assistent-citaat te omzeilen door simpelweg
 * het antwoord te citeren in plaats van de vraag. Dan staat er alsnog een verzonnen datum
 * in het dossier, met "Ja." als onderbouwing.
 *
 * ## Wat het niet is
 *
 * Geen oordeel over of de instemming klopt. De cliënt mag "ja" zeggen en dat mag in het
 * transcript staan — het telt alleen niet als *bron* voor een concrete waarde. Wie iets
 * bevestigt, noemt het niet.
 */

/**
 * Woorden die alleen instemming, twijfel of aarzeling uitdrukken.
 *
 * Bewust kort en letterlijk. Een ruime lijst zou echte antwoorden gaan wegvangen — "nee,
 * dat was in maart" is geen inhoudsloze instemming — en dat is precies het dataverlies
 * dat risico 2 verbiedt.
 */
const INHOUDSLOOS = new Set([
  // instemming
  'ja',
  'jawel',
  'jazeker',
  'klopt',
  'inderdaad',
  'precies',
  'zeker',
  'juist',
  'correct',
  'yes',
  'yeah',
  'right',
  'exactly',
  // ontkenning zonder alternatief
  'nee',
  'nope',
  'no',
  // aarzeling en vulwoorden
  'eh',
  'ehm',
  'uh',
  'uhm',
  'hm',
  'hmm',
  'nou',
  'tja',
  'oke',
  'ok',
  'okay',
  'goed',
  'dat',
  'is',
  'het',
  'was',
  'die',
  'dit',
]);

/**
 * Bestaat dit citaat uitsluitend uit instemming en vulwoorden?
 *
 * Leeg of alleen leestekens telt ook: daar staat helemaal niets in.
 */
export function isContentlessAffirmation(quote: string): boolean {
  const woorden = quote
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (woorden.length === 0) return true;
  return woorden.every((w) => INHOUDSLOOS.has(w));
}
