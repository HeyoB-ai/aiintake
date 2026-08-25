import { createHash } from 'node:crypto';

/**
 * Het adres van de bezoeker bepalen, en er een hash van maken die niet terug te rekenen is.
 *
 * ## Waarom `x-forwarded-for` alleen niet genoeg is
 *
 * Die header is een lijst waar elke tussenliggende proxy iets aan toevoegt. Het eerste
 * element is dus niet "het adres van de bezoeker" maar "wat de bezoeker beweerde toen hij
 * binnenkwam" — een browser mag hem gewoon meesturen, en dan staat er wat hij wil. Op de
 * publieke intakeroute betekent dat: de rate limiting van 5 pogingen per uur is te omzeilen
 * door bij elke poging een ander adres te verzinnen. Elke sessie kost vanaf de eerste seconde
 * geld, dus dat is geen theoretisch lek maar een rekening.
 *
 * De hostingpartij zet daarom zelf een header met het adres van de TCP-verbinding, en die
 * overschrijft hij: Netlify doet dat met `x-nf-client-connection-ip`, Cloudflare met
 * `cf-connecting-ip`. Die is niet te vervalsen, want hij komt niet van de bezoeker.
 *
 * De volgorde hieronder is daarom géén "probeer maar wat": het zijn eerst de headers die de
 * rand zelf schrijft, en pas als laatste de header die de bezoeker kan schrijven.
 *
 * ## Waarom er een peper bij moet
 *
 * Er zijn 4,3 miljard IPv4-adressen. Een kale SHA-256 van een adres is in seconden terug te
 * rekenen door ze allemaal te proberen — de hash is dan een versleuteling zonder sleutel en
 * dus alsnog een persoonsgegeven. `INTAKE_IP_HASH_PEPPER` is die sleutel: hij staat alleen in
 * de serveromgeving, nooit in de database. Wie de tabel heeft maar de peper niet, heeft niets.
 *
 * De variabele stond al in de envvalidatie (packages/db/src/env.ts) met precies deze
 * omschrijving, maar werd nergens gebruikt.
 */

/**
 * Headers die de rand zelf schrijft, op volgorde van vertrouwen.
 *
 * Alleen headers die de hostingpartij overschrijft in plaats van doorlaat. Zet er nooit
 * `x-forwarded-for` bij: die kan de bezoeker zelf sturen.
 */
const RANDHEADERS: readonly string[] = [
  'x-nf-client-connection-ip', // Netlify
  'cf-connecting-ip', // Cloudflare
  'true-client-ip', // Akamai, Cloudflare Enterprise
  'fly-client-ip', // Fly.io
];

export interface IpUitkomst {
  /** Het adres, of null als er niets bruikbaars was. */
  readonly adres: string | null;
  /** Kwam het uit een header die de bezoeker zelf had kunnen zetten? */
  readonly vervalsbaar: boolean;
}

/**
 * Puur, zodat er een test op kan zonder een verzoek na te bouwen.
 *
 * `lees` is bewust een functie en geen object: `headers()` van Next geeft een `Headers`, en
 * die is hoofdletterongevoelig — dat gedrag hoort in de aanroeper te blijven zitten.
 */
export function bepaalClientIp(lees: (naam: string) => string | null): IpUitkomst {
  for (const naam of RANDHEADERS) {
    const waarde = lees(naam)?.trim();
    if (waarde) return { adres: waarde, vervalsbaar: false };
  }

  /*
   * Terugval voor lokale ontwikkeling en voor een omgeving die geen randheader zet.
   *
   * Dit adres is vervalsbaar en dat wordt hier ook gezegd, zodat de aanroeper er iets mee
   * kan in plaats van te denken dat de limiet sluitend is.
   */
  const xff = lees('x-forwarded-for');
  const eerste = xff?.split(',')[0]?.trim();
  if (eerste) return { adres: eerste, vervalsbaar: true };

  return { adres: null, vervalsbaar: true };
}

/**
 * Hash met peper. Nooit het adres zelf opslaan — §14.
 *
 * Zonder peper gooit dit. Stilletjes terugvallen op een kale hash zou het ergste van twee
 * werelden zijn: het ziet eruit alsof er iets beschermd is, terwijl de tabel in een middag
 * terug te rekenen is.
 */
export function hashMetPeper(waarde: string | null, peper: string | undefined): string {
  if (!peper || peper.length < 16) {
    throw new Error(
      'INTAKE_IP_HASH_PEPPER ontbreekt of is te kort (minimaal 16 tekens). ' +
        'Zonder peper is een gehasht IP-adres alsnog herleidbaar.',
    );
  }
  return createHash('sha256')
    .update(`${peper}:${waarde ?? 'onbekend'}`)
    .digest('hex');
}
