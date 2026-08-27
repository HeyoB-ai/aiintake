/**
 * Ziet een uitspraak eruit alsof de cliënt nog niet klaar was?
 *
 * ## Waarom een tijdsdrempel dit niet kan
 *
 * Endpointing sluit een beurt na een vaste stilte. Gemeten geval, met `endpointing` op 700 ms:
 *
 *     19:05:54  U          "Ik moest bij de grootaandeelhouder komen, ik ben directeur,"
 *     19:05:57  U          "en die riep zich bij me"
 *
 * Daar zat een echte pauze van ruim drie seconden tussen. De drempel deed dus precies wat hem
 * was opgedragen — dit is geen te lage instelling. Wat een klok niet kan zien, is dat de zin
 * grammaticaal niet af was.
 *
 * Hem verhogen tot boven drie seconden zou het geval vangen en drie seconden stilte toevoegen
 * aan élke beurt. Dat is de verkeerde ruil: een denkpauze is zeldzaam, wachten is dat niet.
 *
 * ## Wat interpunctie wél zegt
 *
 * Deepgram levert interpunctie (`punctuate`, `smart_format`). Een uitspraak die op een komma
 * eindigt, of op een voegwoord zonder afsluitend leesteken, is bijna nooit een afgeronde beurt.
 * Gemeten over 124 cliëntuitspraken uit echte gesprekken: 85 eindigen op een punt of vraagteken,
 * 12 op een komma of voegwoord.
 *
 * ## Wat dit signaal níét is
 *
 * Het is geen voorspelling dat er nog iets komt. Ik heb geprobeerd dat te toetsen tegen de
 * opgeslagen gesprekken en dat lukt niet: de afstand tot de volgende cliëntregel bevat ook de
 * spreektijd van de assistent, en met elf gemarkeerde gevallen is het verschil (8,0 tegen
 * 10,6 seconde mediaan) niets waard. Dat staat hier omdat de verleiding groot is om zo'n getal
 * alsnog als onderbouwing te presenteren.
 *
 * Wat het wél is: een aanwijzing dat de assistent beter kan uitnodigen om door te gaan dan een
 * nieuwe vraag te stellen. Die keuze is omkeerbaar en kost niets — in tegenstelling tot wachten.
 */

/**
 * Woorden waarop een Nederlandse zin vrijwel nooit eindigt.
 *
 * Voegwoorden, lidwoorden, voorzetsels en persoonlijke voornaamwoorden. Bewust ruim: een valse
 * positieve kost een uitnodiging om door te praten, een valse negatieve kost een vraag die over
 * een halve zin heen gaat.
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
