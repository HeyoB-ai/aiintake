/**
 * E-mailadres en telefoonnummer van de cliënt: klopt dit, en zo nee, wat is er mis?
 *
 * ## Waarom dit in het domein staat en niet in het formulier
 *
 * Het oordeel moet op twee plekken hetzelfde uitvallen. Het formulier moet weigeren wat de
 * server zou weigeren — anders krijgt de cliënt "Het gesprek kon niet worden gestart" bij een
 * typefout, en dat leest als een storing. En de server moet blijven weigeren, want een
 * formulier is geen grens.
 *
 * Zouden dat twee losse regels zijn, dan lopen ze uiteen en is de ene strenger dan de andere.
 * Dezelfde vorm als de samplerate en de tijdzone: één grootheid, meerdere plekken.
 *
 * ## De ruil bij het telefoonnummer
 *
 * Streng valideren stuurt mensen weg. Een Nederlands nummer wordt op minstens vijf manieren
 * geschreven — `0612345678`, `06 12 34 56 78`, `06-12345678`, `+31612345678`,
 * `+31 (0)6 12345678` — en een cliënt die net ontslagen is, gaat geen notatie zitten
 * uitproberen. Buitenlandse nummers bestaan ook: een Belgische grensarbeider heeft er een.
 *
 * Deze controle vangt daarom typefouten en niet-nummers, en niet "een nummer dat volgens de
 * nummerplanautoriteit niet is uitgegeven". Wat erdoorheen komt, wordt uiteindelijk door een
 * mens gebeld. Een vals alarm kost een cliënt die afhaakt; een gemist geval kost een
 * telefoonnummer dat één keer niet blijkt te werken.
 */

/**
 * Is dit een bruikbaar e-mailadres?
 *
 * Minstens zo streng als de database, en dat is geen detail: `create_public_intake` weigert
 * met `v_email not like '%_@_%.__%'`, en wat het formulier doorlaat en de server weigert,
 * belandt in de algemene foutmelding. De eis is dus dezelfde — iets vóór de @, iets erna, en
 * een punt met minstens twee tekens erachter.
 *
 * Niet strenger dan dat. De volledige RFC toelaten is onbegonnen werk, en elke extra regel is
 * een geldig adres dat we per ongeluk weigeren.
 */
export function geldigEmail(waarde: string): boolean {
  const tekst = waarde.trim();
  if (tekst === '' || /\s/.test(tekst)) return false;
  // Precies de eis van de database: naam@domein.tld met een tld van twee of meer tekens.
  return /^[^@]+@[^@.]+(\.[^@.]+)*\.[^@.]{2,}$/.test(tekst);
}

/**
 * De scheidingstekens die mensen in een telefoonnummer zetten.
 *
 * Spaties, streepjes, punten en haakjes. Het haakje hoort erbij vanwege `+31 (0)6 …`, een
 * notatie die op vrijwel elk Nederlands briefpapier staat.
 */
const SCHEIDINGSTEKENS = /[\s\-.()/]/g;

/**
 * Haalt de opmaak eruit en laat het nummer over.
 *
 * Geeft `null` als er iets anders in staat dan cijfers en een leidende `+` — dat is een
 * typefout of geen nummer, en beide horen als zodanig gemeld te worden.
 */
export function normaliseerTelefoon(waarde: string): string | null {
  const kaal = waarde.trim().replace(SCHEIDINGSTEKENS, '');
  if (kaal === '') return null;

  // 0031… is dezelfde notatie als +31…; gelijktrekken zodat er één regel over blijft.
  const metPlus = kaal.startsWith('00') ? `+${kaal.slice(2)}` : kaal;
  if (!/^\+?\d+$/.test(metPlus)) return null;

  /*
   * `+31 (0)6 12345678` levert na het strippen `+3106…` op: een landcode gevolgd door de nul
   * die er in internationale notatie juist uit hoort. Die nul weghalen, anders is het nummer
   * één cijfer te lang en zou het geweigerd worden — terwijl het de meest gedrukte notatie
   * van Nederland is.
   */
  if (metPlus.startsWith('+310')) return `+31${metPlus.slice(4)}`;
  return metPlus;
}

/**
 * Is dit een bruikbaar telefoonnummer?
 *
 * Drie vormen:
 *
 *   `+<landcode><nummer>`  8 tot 15 cijfers na de plus — het bereik van E.164. Zo blijven
 *                          buitenlandse nummers mogelijk zonder dat we per land iets weten.
 *   `0…` (Nederlands)      precies 10 cijfers. Mobiel en vast zijn in Nederland allebei
 *                          tien lang, inclusief de nul.
 *   overig                 geweigerd.
 *
 * Wat dit níét doet: controleren of het netnummer bestaat of het nummer is uitgegeven. Dat
 * zou een tabel vragen die veroudert, en het weigert precies de nummers waar we het minst
 * zeker over zijn.
 */
export function geldigTelefoon(waarde: string): boolean {
  const nummer = normaliseerTelefoon(waarde);
  if (nummer === null) return false;

  if (nummer.startsWith('+')) {
    const cijfers = nummer.slice(1);
    // Niet nul als eerste cijfer: geen enkele landcode begint met een nul.
    return /^[1-9]\d{7,14}$/.test(cijfers);
  }

  return /^0\d{9}$/.test(nummer);
}

/** Welk veld deugt niet. Bepaalt onder welk invoerveld de melding komt te staan. */
export type ContactVeld = 'clientName' | 'clientEmail' | 'clientPhone';

export interface ContactFout {
  readonly veld: ContactVeld;
  /** Voor de cliënt, onder het veld waar de fout zit. Geen jargon, geen foutcode. */
  readonly melding: string;
}

/**
 * Controleert de drie velden en geeft de eerste fout terug.
 *
 * Eén fout tegelijk en niet alle drie: dit scherm wordt op een telefoon ingevuld, en drie
 * rode regels onder elkaar lezen als een formulier dat je niet goed kunt invullen. De velden
 * worden bovendien op volgorde ingevuld.
 *
 * Lege contactvelden zijn geen fout — contactgegevens zijn optioneel, en dat staat als
 * mededeling op het scherm. Een leeg veld is iets anders dan een verkeerd ingevuld veld.
 */
export function controleerContact(invoer: {
  naam: string;
  email: string;
  telefoon: string;
}): ContactFout | null {
  if (invoer.naam.trim().length < 2) {
    return { veld: 'clientName', melding: 'Vul uw voor- en achternaam in.' };
  }
  if (invoer.email.trim() !== '' && !geldigEmail(invoer.email)) {
    return { veld: 'clientEmail', melding: 'Dit lijkt geen geldig e-mailadres.' };
  }
  if (invoer.telefoon.trim() !== '' && !geldigTelefoon(invoer.telefoon)) {
    return {
      veld: 'clientPhone',
      // De notatie erbij, want "ongeldig" laat iemand raden wat er dan wél mag.
      melding: 'Dit lijkt geen geldig telefoonnummer. Bijvoorbeeld: 06 12345678.',
    };
  }
  return null;
}
