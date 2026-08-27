/**
 * De vraag uit een assistentbeurt halen, zonder de zinnen ervoor.
 *
 * ## Waarom dit bestaat
 *
 * Op het cliëntscherm staat de actuele vraag onder de video, zodat iemand die haar niet
 * verstond kan nalezen. Daar stond de héle beurt. Bij de opening is dat vier zinnen — groet,
 * wie ze is, de disclaimer, en dan pas de vraag — en die vier zinnen stonden daarna ook in het
 * transcript eronder. Twee blokken met dezelfde tekst, en geen van beide beantwoordde de vraag
 * "wat werd me nou gevraagd?".
 *
 * ## Waarom de laatste zin de vraag is
 *
 * Dat is geen aanname over taal maar een regel die de prompt afdwingt: *"Maximaal N zinnen per
 * beurt. Eén vraag tegelijk."* en bij de opening *"Na de vraag laat u het aan de cliënt. Geen
 * tweede vraag, geen lijstje, geen aansporing."* De vraag staat dus achteraan, en er is er één.
 *
 * Houdt het model zich daar niet aan, dan is de uitkomst nog steeds bruikbaar: bij meerdere
 * vraagtekens wint de laatste, en dat is de vraag waarop de cliënt geacht wordt te antwoorden.
 *
 * ## Waarom niet het model erom vragen
 *
 * Dat zou een tweede veld op het hot path betekenen — een gesloten schema of een extra aanroep,
 * en beide kosten latency op de weg waar die het duurst is. Deze scheiding is deterministisch,
 * kost niets, en faalt zichtbaar: komt er geen vraagteken in voor, dan valt hij terug op de
 * laatste zin, en dat is precies wat er dan te lezen valt.
 *
 * ## Wat er níét mee gebeurt
 *
 * Het transcript houdt de volledige beurt. Dit knipt alleen wat er bovenaan staat; wie de
 * disclaimer wil nalezen, vindt hem in de lijst. De rest weglaten uit het transcript zou het
 * onvolledig maken, en dat is precies wat een transcript niet mag zijn.
 */

/**
 * Zinseinde: een punt, vraagteken of uitroepteken, gevolgd door witruimte en een hoofdletter,
 * aanhalingsteken of cijfer.
 *
 * Die eis op wat erna komt is wat afkortingen en bedragen buiten schot houdt. "€ 2.500" heeft
 * een punt met een cijfer erachter maar geen spatie; "bijv. het salaris" heeft een spatie maar
 * een kleine letter. Beide splitsen dus niet.
 *
 * Volledig is dit niet — "Dhr. Jansen" splitst wél, want daar volgt een hoofdletter. Dat is
 * hier onschadelijk: het knipt hooguit een zin te vroeg af, en de vraag zelf blijft heel.
 */
const ZINSEINDE = /([.!?])\s+(?=["'“„]?[A-ZÀ-Þ0-9])/g;

/**
 * Een scheidingsteken dat in gesproken Nederlands niet voorkomt.
 *
 * Nodig omdat de eerste versie na het leesteken een spatie zette en daarna op de spatie
 * splitste — wat op élke spatie splitst, en dus op elk woord. Een teken uit het
 * private-use-gebied van Unicode komt niet uit een spraakherkenner en niet uit een model.
 */
const SCHEIDING = '\u{E000}';

/** De beurt in zinnen, met de leestekens eraan vast. */
export function inZinnen(tekst: string): string[] {
  const genormaliseerd = tekst.replace(/\s+/gu, ' ').trim();
  if (genormaliseerd === '') return [];
  return genormaliseerd
    .replace(ZINSEINDE, `$1${SCHEIDING}`)
    .split(SCHEIDING)
    .map((z) => z.trim())
    .filter(Boolean);
}

/**
 * De vraag uit een beurt. Leeg als er geen tekst is.
 *
 * Bij meerdere vragen wint de laatste: daarop wordt de cliënt geacht te antwoorden. Zonder
 * vraagteken valt hij terug op de laatste zin — bij de afronding ("Een advocaat kijkt ernaar")
 * is dat de mededeling, en die hoort daar dan ook te staan.
 */
export function laatsteVraag(tekst: string): string {
  const zinnen = inZinnen(tekst);
  if (zinnen.length === 0) return '';

  for (let i = zinnen.length - 1; i >= 0; i -= 1) {
    if (zinnen[i]!.includes('?')) return zinnen[i]!;
  }
  return zinnen[zinnen.length - 1]!;
}
