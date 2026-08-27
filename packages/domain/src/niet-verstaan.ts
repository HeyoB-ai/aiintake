/**
 * De regel die een gat in het gesprek zichtbaar maakt.
 *
 * ## Waarom deze zin bestaat
 *
 * Een overgeslagen beurt liet nergens een spoor na: `onSkippedTurn` ging naar het worker-log en
 * naar de HUD, en het transcript las als een doorlopend gesprek. Wat er ontbrak was niet te
 * zien — en dat is wat een dossier onbruikbaar maakt, want het ziet er compleet uit.
 *
 * ## Waarom hij hier staat en niet op twee schermen
 *
 * Hij hoort op twee plekken te verschijnen: in het transcript dat de advocaat leest, en op het
 * scherm van de cliënt zelf. Die tweede ontbrak — het cliëntscherm kent alleen "U" en
 * "Assistent" — en de cliënt merkte dus niet dat er iets van hem niet was aangekomen.
 *
 * Dezelfde zin op twee plekken uitschrijven is precies de vorm die deze week vijf keer iets
 * heeft gekost. Dus één keer, hier.
 *
 * ## Waarom hij zo geformuleerd is
 *
 * Voor een mens, niet voor een ontwikkelaar. Geen regelnaam, geen code, geen aantal tekens —
 * dat aantal is de lengte van een tussentijds transcript en geen maat voor hoeveel er is
 * gezegd. Wat er staat is wat er waar is: hier is iets gezegd en het staat er niet.
 */
export const NIET_VERSTAAN = {
  nl:
    'Hier heeft de cliënt iets gezegd dat niet is verstaan. ' +
    'De spraakherkenning ving wel geluid op maar leverde geen tekst; ' +
    'wat op dit punt is gezegd, ontbreekt in dit transcript.',
  en:
    'Here the client said something that was not understood. ' +
    'Speech recognition picked up sound but produced no text; ' +
    'what was said at this point is missing from this transcript.',
} as const;

/**
 * Dezelfde mededeling, gericht aan de cliënt zelf.
 *
 * Kort en in de tweede persoon: hij leest dit tijdens het gesprek en moet er iets mee kunnen —
 * namelijk het herhalen. De transcriptregel hierboven is beschrijvend en voor later.
 */
export const NIET_VERSTAAN_CLIENT = {
  nl: 'Dit is niet goed verstaan. Wilt u het herhalen?',
  en: 'That was not understood. Could you repeat it?',
} as const;
