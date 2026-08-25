/**
 * Wanneer mag een sessie sluiten omdat er niets gebeurt?
 *
 * ## Waarom dit een aparte functie is
 *
 * De eerste versie stond los in de liveserver en begon te lopen zodra de WebSocket
 * openging. Dat is te vroeg op twee manieren tegelijk: de keten staat er dan nog niet, en
 * de cliënt heeft nog niets kúnnen zeggen. Zo'n regel is bovendien alleen te toetsen door
 * een hele sessie op te zetten — met een STT, een TTS en een avatar erbij — en dan hangt
 * de controle af van drie leveranciers die niets met de regel te maken hebben. Toen
 * Cartesia's tegoed op was, was hij helemaal niet meer te toetsen.
 *
 * Hier staat alleen de beslissing. Geen klok, geen I/O, geen sessie: tijden erin, een
 * ja of nee eruit.
 *
 * ## De regel
 *
 * 1. **Geen gesprek begonnen, geen klok.** Zolang de eerste beurt niet loopt, is stilte
 *    geen signaal maar de normale gang van zaken.
 * 2. **Respijt na de start.** De openingsbeurt duurt al zo'n vijftien seconden, en daarna
 *    mag iemand nadenken voordat hij antwoordt. In die periode loopt de klok niet.
 * 3. **Daarna pas tellen.** Vanaf het laatste van (einde respijt, laatste spraak) telt de
 *    limiet.
 *
 * Te vroeg afkappen is veel erger dan een teller die iets later afgaat: het eerste breekt
 * een gesprek af, het tweede kost een paar seconden avatartijd.
 */

export interface InactiviteitStand {
  /** Nu, op dezelfde monotone klok als de andere velden. */
  readonly nu: number;
  /**
   * Wanneer het gesprek werkelijk begon.
   *
   * Met avatar is dat het eerste videoframe, zonder avatar het moment waarop de browser
   * om de eerste beurt vraagt. `null` betekent: nog niet begonnen.
   */
  readonly gesprekBegonOp: number | null;
  /** Wanneer de cliënt voor het laatst hoorbaar was. `null` als dat nog nooit gebeurde. */
  readonly laatsteActiviteitOp: number | null;
  /** Hoe lang stilte mag duren voordat de sessie sluit. */
  readonly limietMs: number;
  /** Hoe lang na de start de klok helemaal niet loopt. */
  readonly respijtMs: number;
}

/**
 * Vanaf welk moment de stilte telt.
 *
 * Losstaand omdat de HUD hem ook wil laten zien: "nog 42 s" is bruikbaar, "de sessie is
 * dicht" is een mededeling achteraf.
 */
export function telVanaf(stand: InactiviteitStand): number | null {
  if (stand.gesprekBegonOp === null) return null;
  const naRespijt = stand.gesprekBegonOp + stand.respijtMs;
  return Math.max(naRespijt, stand.laatsteActiviteitOp ?? 0);
}

/** Hoeveel milliseconde er nog te gaan is. `null` zolang de klok niet loopt. */
export function resterendMs(stand: InactiviteitStand): number | null {
  const vanaf = telVanaf(stand);
  if (vanaf === null) return null;
  return Math.max(0, vanaf + stand.limietMs - stand.nu);
}

/** Mag de sessie nu sluiten wegens stilte? */
export function magAfsluitenWegensStilte(stand: InactiviteitStand): boolean {
  const rest = resterendMs(stand);
  return rest !== null && rest <= 0;
}
