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

/**
 * Vanaf hoeveel woorden een zin zonder afsluitend leesteken onafgerond heet.
 *
 * ## Gemeten, niet gekozen
 *
 * De eerste versie keek alleen naar een komma of een hangend laatste woord. Van 51
 * cliëntuitspraken uit acht gevoerde gesprekken viel dat als volgt uiteen:
 *
 *     eindigt op . ? !            39   76%   niet gemarkeerd, terecht
 *     eindigt op een komma         1    2%   gemarkeerd
 *     eindigt op een hangend woord 0    0%   gemarkeerd
 *     eindigt kaal                11   22%   NIET gemarkeerd  <- het gat
 *
 * Die elf kale gevallen zijn twee verschillende dingen, en ze scheiden op lengte:
 *
 *     "…bij een concurrent om dingen te bespreken en dat heeft mijn compagnon gehoord"
 *     "en die riep zich bij me"
 *     "Ja, ik ben gisteren mondeling"          <- afgekapt vóór "ontslagen"
 *
 *     "Technohub BV"   "8500 euro"   "Nee"   "Beentje"   "exclusief"   "R0VC"
 *
 * De eerste drie zijn afgekapte zinnen van vijf woorden of meer. De andere acht zijn
 * complete antwoorden van hoogstens drie woorden — een werkgeversnaam, een bedrag, een
 * gespelde afkorting. Op deze verzameling scheidt een grens van vier woorden ze zonder
 * fout: drie terecht gemarkeerd, nul ten onrechte.
 *
 * ## Waarom een lengte hier wél mag en een klok niet
 *
 * De lengte is bekend op het moment dat de beurt sluit, uit de tekst zelf. Een tijdsdrempel
 * moet raden hoe lang iemand nog gaat zwijgen, en die stilte kan een onderbreking van de
 * assistent blijken (zie boven). Dit is een eigenschap van de uitspraak, niet van de pauze.
 *
 * ## Wat het kost als het misgaat
 *
 * Een vals alarm kost `ONAFGEROND_WACHT_MS` aan stilte op één beurt. Een gemist geval kost een
 * vraag die over een halve zin heen gaat. Acht van de 51 uitspraken worden nu gemarkeerd.
 */
const MIN_WOORDEN_ZONDER_LEESTEKEN = 4;

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
  if (laatste !== undefined && HANGENDE_WOORDEN.has(laatste)) return true;

  /*
   * Geen leesteken en toch een hele zin: dan is hij waarschijnlijk afgekapt.
   *
   * De herkenner zet een punt zodra hij denkt dat de uitspraak af is. Doet hij dat niet bij
   * iets van vier woorden of meer, dan hield de spreker in — een adempauze midden in een zin,
   * zonder komma en zonder voegwoord. Dat was het gat dat de eerste versie liet vallen; zie
   * MIN_WOORDEN_ZONDER_LEESTEKEN voor de meting.
   *
   * Korte antwoorden blijven er buiten. "Technohub BV" en "8500 euro" krijgen ook geen punt
   * en zijn wél af.
   */
  return woorden.length >= MIN_WOORDEN_ZONDER_LEESTEKEN;
}
