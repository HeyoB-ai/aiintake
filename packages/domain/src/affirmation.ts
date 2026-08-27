import { INHOUDSLOZE_WOORDEN } from './korte-uitingen';
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
 * Bestaat dit citaat uitsluitend uit instemming en vulwoorden?
 *
 * Leeg of alleen leestekens telt ook: daar staat helemaal niets in.
 */
export function isContentlessAffirmation(quote: string): boolean {
  /*
   * Het koppelteken blijft staan.
   *
   * Hier stond `[^\p{L}\p{N}\s]`, en dat maakte van "mm-hm" twee woorden: "mm" en "hm". "mm"
   * staat in geen enkele lijst, dus een luistergeluid gold als inhoud — terwijl de
   * backchannel-kant het wél als één woord ziet. Twee normalisaties op dezelfde woorden.
   *
   * Een los koppelteken wordt hierdoor een eigen woord dat nergens in staat, en dat is de
   * veilige kant op: dan geldt het citaat als inhoudelijk en gooien we niets weg.
   */
  const woorden = quote
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (woorden.length === 0) return true;
  return woorden.every((w) => INHOUDSLOZE_WOORDEN.has(w));
}
