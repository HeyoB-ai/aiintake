/**
 * Ziet een uitspraak eruit alsof de cliënt nog niet klaar was?
 *
 * ## Waarom een tijdsdrempel dit niet kan zien
 *
 * Endpointing sluit een beurt na een vaste stilte. Gemeten geval, met `endpointing` op 700 ms:
 *
 *     19:05:54,782  U          "Ik moest bij de grootaandeelhouder komen, ik ben directeur,"
 *     19:05:54,828  ASSISTENT  "Gaat u door, wat gebeurde daar?"
 *     19:05:57,914  U          "en die riep zich bij me"
 *
 * Een klok ziet hier een cliënt die drie seconden zweeg. Dat is niet wat er gebeurde: hij haalde
 * adem, de assistent begon te praten, en dáárom hield hij zijn mond. Die drie seconden zijn haar
 * spreektijd plus zijn reactie erop.
 *
 * Wat een komma wél ziet: dat de zin op 19:05:54 grammaticaal niet af was. Dat is bekend op het
 * moment dat de beurt sluit, vóór er iemand iets zegt.
 *
 * ## De meetfout die hierbij hoort
 *
 * **Wat als stilte in de data staat, kan een onderbreking zijn geweest.** De opgeslagen rijen
 * bevatten alleen de tijdstempels van beurten, niet wie er op welk moment geluid maakte. "Cliënt
 * pauzeert drie seconden" en "cliënt haalt adem, assistent praat, cliënt houdt in" zijn er niet
 * uit elkaar te houden.
 *
 * Daarmee is elke meting op basis van tijdsafstand tussen cliëntregels onbetrouwbaar — óók de
 * meting waarmee ik dit signaal eerst probeerde te valideren (elf gemarkeerde gevallen, 8,0 tegen
 * 10,6 seconde mediaan). Die zei niets, en nu is duidelijk waaróm hij niets kon zeggen. Dat staat
 * hier omdat de verleiding groot is om zo'n getal alsnog als onderbouwing te presenteren.
 *
 * ## Wat interpunctie wél zegt
 *
 * Deepgram levert interpunctie (`punctuate`, `smart_format`). Een uitspraak die op een komma
 * eindigt, of op een voegwoord zonder afsluitend leesteken, is bijna nooit een afgeronde beurt.
 * Gemeten over 124 cliëntuitspraken uit echte gesprekken: 85 eindigen op een punt of vraagteken,
 * 12 op een komma of voegwoord.
 *
 * ## Wat de lus ermee doet: zwijgen
 *
 * Niet aanmoedigen. De eerste versie liet de assistent "Gaat u door." zeggen — precies wat zij in
 * het gemeten geval deed, en precies waardoor de cliënt zijn zin niet afmaakte. Een aanmoediging
 * is zélf een onderbreking; een mens die hoort dat je nog niet klaar bent, zegt niets en wacht.
 *
 * Het signaal stuurt daarom een wachttijd in `turn-loop.ts` (`ONAFGEROND_WACHT_MS`) en niet een
 * regel in de prompt. Hoe lang die moet zijn is niet uit te rekenen — zie de meetfout hierboven —
 * dus hij is verstelbaar en wordt op gehoor geijkt, net als de endpointing zelf.
 */

/**
 * Woorden waarop een Nederlandse zin vrijwel nooit eindigt.
 *
 * Voegwoorden, lidwoorden, voorzetsels en persoonlijke voornaamwoorden. Bewust ruim, en dat is
 * een keuze die je kunt terugdraaien met één getal: een valse positieve kost `ONAFGEROND_WACHT_MS`
 * aan wachttijd, een valse negatieve kost een vraag die over een halve zin heen gaat. Wordt het
 * wachten te duur, dan is de drempel de knop — niet deze lijst.
 *
 * `dat` en `die` staan erin terwijl ze een zin kúnnen afsluiten ("Ik wil dat"). In gesproken
 * Nederlands is dat zeldzaam genoeg om de ruil waard te zijn.
 */
const HANGENDE_WOORDEN = new Set([
  // voegwoorden
  'en',
  'maar',
  'want',
  'omdat',
  'dus',
  'of',
  'als',
  'toen',
  'terwijl',
  'zodat',
  'hoewel',
  'doordat',
  // verwijzend
  'die',
  'dat',
  'wat',
  'welke',
  // lidwoorden en aanwijzend
  'de',
  'het',
  'een',
  'deze',
  'dit',
  // voorzetsels
  'van',
  'met',
  'op',
  'in',
  'voor',
  'naar',
  'bij',
  'om',
  'te',
  'aan',
  'over',
  'door',
  'tot',
  // persoonlijk
  'ik',
  'je',
  'u',
  'hij',
  'ze',
  'we',
]);

export function lijktOnafgerond(uitspraak: string): boolean {
  const tekst = uitspraak.trim();
  if (tekst === '') return false;

  // Een komma aan het eind is het duidelijkste signaal dat er meer zou komen.
  if (tekst.endsWith(',')) return true;

  /*
   * Een afsluitend leesteken wint van het laatste woord.
   *
   * "Nee, dat klopt, dus hij ook." eindigt op "ook" — een woord dat op zichzelf hangend
   * klinkt — maar de punt zegt dat de herkenner de zin als af beschouwde. Zonder deze regel
   * markeerde de eerste versie precies zulke afgeronde zinnen als onafgerond.
   */
  if (/[.?!]$/.test(tekst)) return false;

  const woorden = tekst
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const laatste = woorden[woorden.length - 1];
  return laatste !== undefined && HANGENDE_WOORDEN.has(laatste);
}
