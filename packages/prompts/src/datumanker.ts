import type { Language } from '@intake/domain';
import { STANDAARD_TIJDZONE } from './groet';

/**
 * Het ankerpunt waarmee "afgelopen vrijdag" een datum wordt.
 *
 * ## Waarom een kale ISO-datum niet genoeg is
 *
 * De extractieprompt kreeg `Vandaag is 2026-08-22.` en verder niets. Daar zijn twee dingen
 * mis mee, en allebei landen ze in `case_facts`.
 *
 * **Het was de UTC-datum.** De worker draait op UTC. Tussen middernacht en twee uur
 * 's nachts (zomertijd) is dat een dag eerder dan in Nederland. Een cliënt die om half één
 * 's nachts "gisteren" zegt, kreeg eergisteren.
 *
 * **En er stond geen weekdag bij.** "Afgelopen vrijdag" is niet uit te rekenen zonder te
 * weten welke dag vandaag is. Het model kan de weekdag uit de datum afleiden, maar dat is
 * hoofdrekenen op een kalender — precies het soort stille fout dat risico 10 beschrijft.
 * De weekdag staat er nu bij, want die is hier gratis en daar onzeker.
 *
 * ## Wat er níét bij hoort
 *
 * Geen omrekening van de relatieve uitdrukkingen zelf. Verleiding is groot om
 * "afgelopen vrijdag" hier al naar een datum te vertalen, maar dan zou deze module moeten
 * weten wat de cliënt zei — en dat is de taak van de extractie. Dit levert het anker; de
 * regels over wat je ermee doet staan in extraction.ts.
 */

export interface DatumAnker {
  /** ISO-datum in de zone van het kantoor, bijvoorbeeld 2026-08-22. */
  readonly iso: string;
  /** De weekdag in de taal van het gesprek, bijvoorbeeld "zaterdag". */
  readonly weekdag: string;
  /**
   * Dezelfde weekdag als getal, maandag = 1 … zondag = 7.
   *
   * Voor `resolveWeekdag` uit het domein. Bewust uit hetzelfde anker als de naam die in de
   * prompt komt: zouden die twee apart worden berekend, dan kunnen de instructie en het
   * vangnet het oneens worden over welke dag het is.
   */
  readonly weekdagIndex: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Lokale tijd in HH:MM, zodat "vanochtend" en "vanavond" te plaatsen zijn. */
  readonly tijd: string;
  /** De zone waarin dit alles is gerekend; staat in de prompt zodat het naspeelbaar is. */
  readonly timeZone: string;
}

const LOCALE: Record<Language, string> = { nl: 'nl-NL', en: 'en-GB' };

/**
 * De datum in een gegeven zone, als YYYY-MM-DD.
 *
 * Via `en-CA` omdat die locale precies het ISO-formaat oplevert; `toISOString()` zou de
 * UTC-datum geven en dat is nu juist het probleem.
 */
function isoDatumInZone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function datumAnker(
  now: Date,
  language: Language,
  timeZone: string = STANDAARD_TIJDZONE,
): DatumAnker {
  const weekdag = new Intl.DateTimeFormat(LOCALE[language], {
    timeZone,
    weekday: 'long',
  }).format(now);

  const tijd = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);

  // Via de Engelse korte naam, want die is stabiel; de gelokaliseerde naam is dat niet.
  const kort = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(now);
  const volgorde = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const index = volgorde.indexOf(kort) + 1;
  if (index === 0) throw new Error(`Onbekende weekdag "${kort}" voor zone ${timeZone}`);

  return {
    iso: isoDatumInZone(now, timeZone),
    weekdag,
    weekdagIndex: index as DatumAnker['weekdagIndex'],
    tijd,
    timeZone,
  };
}
