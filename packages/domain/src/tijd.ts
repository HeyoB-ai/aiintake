/**
 * De enige plek waar een tijdstip een leesbare tekst wordt.
 *
 * ## Wat er misging
 *
 * De dossierpagina toonde "Ontvangen 27-08-2026, 11:53" voor een gesprek van 13:53. Twee uur
 * verschil. De transcriptregels ernaast toonden wél 13:53:38.
 *
 * De oorzaak is niet dat iemand de tijdzone vergat — die stond op géén van de zes plekken. Het
 * verschil zat in wáár de code draaide: `transcript.tsx` is een clientcomponent en rendert in de
 * browser (Europe/Amsterdam), `page.tsx` is een servercomponent en rendert op Netlify (UTC).
 * `new Date(x).toLocaleString('nl-NL')` zonder `timeZone` neemt de zone van de omgeving, en die
 * verschilt dus per component.
 *
 * Dat is erger dan een verkeerde zone. Dezelfde uitdrukking gaf twee antwoorden, en welke je
 * kreeg hing af van een architectuurdetail dat niets met tijd te maken heeft.
 *
 * ## Waarom `timeZone` verplicht is
 *
 * Geen standaardwaarde. Een parameter met een terugval is precies de vorm waarin dit stil
 * misgaat: wie hem vergeet, krijgt geen fout maar de zone van de server. Als verplicht argument
 * is vergeten een compilefout.
 *
 * Dezelfde afweging als bij `AvatarSessionOptions.sampleRate`, en om dezelfde reden — daar
 * bleven twee providers op 16 kHz staan toen de rest naar 24 ging, en niets viel om.
 *
 * ## Waarom de zone van het kantoor en niet van de lezer
 *
 * `organizations.time_zone` staat per kantoor in de database. Een advocaat die op vakantie in
 * Lissabon een dossier opent, hoort de tijden van zijn kantoor te zien: een vervaltermijn wordt
 * berekend tegen de zone waarin het kantoor werkt, en een intake die "om 09:00" binnenkwam, is
 * om 09:00 kantoortijd binnengekomen.
 *
 * ## Waarom dit ertoe doet
 *
 * Twee uur is bij een tijdstip een ongemak. Bij een vervaltermijn is het soms een dag: een
 * gesprek van dinsdag 00:30 staat in UTC op maandag, en dan telt een advocaat een dag verkeerd
 * op een termijn die niet verschuift.
 */

/** Een IANA-zone, zoals `Europe/Amsterdam`. Komt uit `organizations.time_zone`. */
export type Tijdzone = string;

/**
 * De terugval, en die staat hier zodat hij één plek heeft.
 *
 * Bedoeld voor wanneer de organisatie niet is opgehaald — niet als standaardargument. Een
 * aanroeper die hem gebruikt, doet dat zichtbaar.
 */
export const TIJDZONE_TERUGVAL: Tijdzone = 'Europe/Amsterdam';

function formatteer(
  waarde: string | Date | null | undefined,
  zone: Tijdzone,
  opties: Intl.DateTimeFormatOptions,
): string {
  if (waarde === null || waarde === undefined || waarde === '') return '—';
  const d = waarde instanceof Date ? waarde : new Date(waarde);
  // Een onleesbare datum hoort niet als "Invalid Date" op het scherm te komen. Een streepje
  // zegt hetzelfde als een lege cel en liegt niet over de inhoud.
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('nl-NL', { ...opties, timeZone: zone }).format(d);
}

/** Datum en tijd, kort. Voor lijsten en kerngegevens: `27-08-2026 13:53`. */
export function datumTijd(waarde: string | Date | null | undefined, zone: Tijdzone): string {
  return formatteer(waarde, zone, { dateStyle: 'short', timeStyle: 'short' });
}

/** Datum en tijd met seconden. Voor het auditlog, waar volgorde binnen een minuut telt. */
export function datumTijdSeconden(
  waarde: string | Date | null | undefined,
  zone: Tijdzone,
): string {
  return formatteer(waarde, zone, { dateStyle: 'short', timeStyle: 'medium' });
}

/** Alleen de datum. Voor een kolom waar de tijd niet toe doet. */
export function alleenDatum(waarde: string | Date | null | undefined, zone: Tijdzone): string {
  return formatteer(waarde, zone, { dateStyle: 'short' });
}

/**
 * Alleen de klok, met seconden. Voor transcriptregels binnen één gesprek.
 *
 * Daar is de datum ruis — alle regels zijn van dezelfde dag — en de seconden juist niet: die
 * laten zien hoe snel er is geantwoord en waar een stilte viel.
 */
export function alleenTijd(waarde: string | Date | null | undefined, zone: Tijdzone): string {
  return formatteer(waarde, zone, { timeStyle: 'medium' });
}
