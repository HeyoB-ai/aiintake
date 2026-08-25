import type { Language } from '@intake/domain';

/**
 * De groet die bij het tijdstip hoort.
 *
 * De engine heeft `now` al; zonder deze functie liet de prompt de keuze aan het model, en
 * dat kiest "Goedemorgen" om acht uur 's avonds. Een model heeft geen klok, en het is
 * onnodig om er een te suggereren: het tijdstip is bekend.
 *
 * ## 's Nachts helemaal geen groet
 *
 * Tussen middernacht en zes uur geeft deze functie `null` terug. "Goedenacht" is in het
 * Nederlands een afscheid — je zegt het als je weggaat of gaat slapen — dus iemand ermee
 * ontvangen klinkt als wegsturen. "Goedenavond" om drie uur 's nachts is ook vreemd. Dan
 * is niets zeggen het minst opvallend: de assistent begint gewoon met wie ze is.
 *
 * Engels heeft hetzelfde probleem met "Good night", en krijgt dezelfde behandeling.
 *
 * ## Tijdzone
 *
 * `now` is een moment, geen tijd van de dag; welk uur dat is hangt van de zone af. De
 * worker draait op UTC, dus zonder zone zou de groet twee uur achterlopen en zou de
 * cliënt om tien uur 's ochtends nog "Goedemorgen" horen tot twee uur 's middags.
 *
 * De zone komt uit de organisatieconfiguratie (`OrgConfig.timeZone`) en staat niet in deze
 * code. Zie de motivatie daar.
 */

export const STANDAARD_TIJDZONE = 'Europe/Amsterdam';

/** Grenzen in hele uren, lokale tijd. */
const OCHTEND_VANAF = 6;
const MIDDAG_VANAF = 12;
const AVOND_VANAF = 18;

const GROETEN: Record<Language, { ochtend: string; middag: string; avond: string }> = {
  nl: { ochtend: 'Goedemorgen', middag: 'Goedemiddag', avond: 'Goedenavond' },
  en: { ochtend: 'Good morning', middag: 'Good afternoon', avond: 'Good evening' },
};

/**
 * Het uur van de dag in een gegeven tijdzone.
 *
 * Via `Intl` en niet via `getHours()`: die laatste gebruikt de zone van het proces, en
 * daarmee zou de groet afhangen van waar de server toevallig staat.
 */
export function uurInZone(now: Date, timeZone: string = STANDAARD_TIJDZONE): number {
  const opgemaakt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(now);
  const uur = Number.parseInt(opgemaakt, 10);
  if (!Number.isFinite(uur)) throw new Error(`Kan het uur niet bepalen voor zone ${timeZone}`);
  // Intl geeft in sommige omgevingen "24" voor middernacht.
  return uur % 24;
}

/**
 * De groet, of `null` als er op dit uur geen passende groet is.
 *
 * `null` is een echte uitkomst en geen foutgeval: zie de kop over de nacht.
 */
export function dagdeelGroet(
  now: Date,
  language: Language,
  timeZone: string = STANDAARD_TIJDZONE,
): string | null {
  const uur = uurInZone(now, timeZone);
  const woorden = GROETEN[language];
  if (uur < OCHTEND_VANAF) return null;
  if (uur >= AVOND_VANAF) return woorden.avond;
  if (uur >= MIDDAG_VANAF) return woorden.middag;
  return woorden.ochtend;
}
