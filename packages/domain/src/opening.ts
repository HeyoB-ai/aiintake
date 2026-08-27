import type { Language } from './enums';

/**
 * De openingszin: vast, met invulplekken.
 *
 * ## Waarom hij niet meer van het model komt
 *
 * De prompt gaf het model een letterlijk sjabloon en vier regels over wat daarin vastligt. Het
 * model volgde dat sjabloon **teken voor teken**: 338 tekens gemeten in productie, 338 tekens
 * in het sjabloon. Er werd dus een modelaanroep gedaan om een vaste tekst terug te krijgen.
 *
 * Dat kost drie dingen. Latency op de beurt waar de cliënt het langst op wacht. Tokens voor
 * iets wat we al weten. En een risico dat geen enkele winst tegenover zich heeft: een model dat
 * een keer níét reproduceert, laat de disclaimer weg of zwakt hem af — precies de zin waarvoor
 * de cliënt op het toestemmingsscherm tekent (risico 17).
 *
 * Dezelfde redenering als bij de erkenning, de wanhoopsreactie en de hervatting: **het model
 * beoordeelt, de woorden liggen vast.** Hier valt er niet eens iets te beoordelen — of dit de
 * opening is, weet de lus zelf.
 *
 * ## Wat er is ingekort, en wat niet
 *
 * Het oude sjabloon noemde het kantoor twee keer en "uw zaak" twee keer:
 *
 * > Ik ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen, zodat een
 * > advocaat van {kantoor} uw zaak sneller kan beoordelen.
 *
 * Die herhaling is eruit. Wat er blijft staan zijn de vier mededelingen zelf, geen ervan
 * afgezwakt: wie ze is (met "AI" er letterlijk in), wat ze doet, dat ze geen advocaat is, en
 * dat ze geen advies geeft.
 *
 * **De twee disclaimerzinnen staan nu los.** Het oude sjabloon plakte ze aan de taak vast met
 * "en" — "Ik ben geen advocaat en ben aangesteld om…" — terwijl de regel eronder in diezelfde
 * prompt letterlijk verbood om twee mededelingen met een komma en "en" aan elkaar te plakken,
 * omdat ze elk op zichzelf moeten landen. Het sjabloon overtrad zijn eigen regel.
 *
 * ## De volgorde ligt vast en is niet willekeurig
 *
 * Eerst wat ze wél doet, daarna pas wat ze niet doet. Een beperking is pas te plaatsen als
 * iemand weet waar je voor bent; andersom klinkt het als een voorbehoud vooraf.
 *
 * ## Wat dit niet oplost
 *
 * De opening blijft lang. Op het gemeten tempo van ongeveer 58 ms per teken kost 285 tekens
 * zestien seconden, tegen negentien voor de oude. De ondergrens wordt bepaald door wat er
 * gezegd móét worden, niet door de formulering — verder inkorten betekent een mededeling
 * schrappen, en dat is een besluit van het kantoor en niet van de code.
 */

export interface OpeningOpties {
  /** De groet die bij het tijdstip hoort, of `null` 's nachts. Zie groet.ts. */
  readonly greeting: string | null;
  /** De naam die de cliënt heeft ingevuld, of `null`. */
  readonly clientName: string | null;
  readonly organisationName: string;
}

export function openingsZin(o: OpeningOpties, language: Language = 'nl'): string {
  const aanhef = o.greeting
    ? `${o.greeting}${o.clientName ? `, ${o.clientName}` : ''}.`
    : o.clientName
      ? `${o.clientName}.`
      : null;

  if (language === 'en') {
    return [
      aanhef,
      `I am the AI intake assistant of ${o.organisationName}.`,
      'I record the details of your case so a lawyer can review it sooner.',
      'I am not a lawyer.',
      'I do not give legal advice myself.',
      'Could you tell me what is going on and why you are getting in touch?',
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [
    aanhef,
    `Ik ben de AI-intake-assistent van ${o.organisationName}.`,
    'Ik leg de gegevens van uw zaak vast, zodat een advocaat er sneller naar kan kijken.',
    'Ik ben geen advocaat.',
    'Zelf geef ik geen juridisch advies.',
    'Kunt u vertellen wat er speelt en waarom u contact opneemt?',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Alle varianten, zodat een test kan controleren wat er in élke vorm in staat. */
export const ALLE_OPENINGSZINNEN: readonly string[] = [
  openingsZin({ greeting: 'Goedemiddag', clientName: 'Sanne de Vries', organisationName: 'X' }),
  openingsZin({ greeting: null, clientName: 'Sanne de Vries', organisationName: 'X' }),
  openingsZin({ greeting: 'Goedemiddag', clientName: null, organisationName: 'X' }),
  openingsZin({ greeting: null, clientName: null, organisationName: 'X' }),
  openingsZin(
    { greeting: 'Good afternoon', clientName: 'Sanne de Vries', organisationName: 'X' },
    'en',
  ),
  openingsZin({ greeting: null, clientName: null, organisationName: 'X' }, 'en'),
];
