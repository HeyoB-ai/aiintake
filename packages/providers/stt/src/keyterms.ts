/**
 * Nederlandse juridische keyterms voor de spraakherkenning.
 *
 * Spraakmodellen zijn getraind op algemeen Nederlands en struikelen voorspelbaar over
 * arbeidsrechtelijk jargon: "vaststellingsovereenkomst" wordt "vast stellings
 * overeenkomst", "ontslag op staande voet" wordt "ontslag op staande voet" of iets
 * heel anders, en "WW-uitkering" wordt zelden goed. Keyterm prompting verhoogt de
 * kans dat deze woorden correct worden herkend.
 *
 * Waarom dit hier staat en niet in de Deepgram-adapter: de lijst is inhoudelijk, niet
 * technisch. Hij hoort bij het rechtsgebied, en elke STT-leverancier met keyterm- of
 * vocabulary-ondersteuning kan hem gebruiken. Een adapter vertaalt hem hooguit naar
 * het formaat van die leverancier.
 *
 * De lijst is bewust kort gehouden. Te veel keyterms verwatert het effect en kost
 * latency bij het opzetten van de stream; de vuistregel bij de meeste leveranciers is
 * enkele tientallen, niet honderden.
 */

/** Termen die het gesprek structureel bepalen — deze moeten kloppen. */
export const EMPLOYMENT_KEYTERMS_NL: readonly string[] = [
  // Beëindiging
  'vaststellingsovereenkomst',
  'beëindigingsovereenkomst',
  'ontslag op staande voet',
  'dringende reden',
  'opzegtermijn',
  'opzegverbod',
  'transitievergoeding',
  'billijke vergoeding',
  'ontbindingsverzoek',
  'kantonrechter',
  'UWV',
  'ontslagvergunning',
  'aanzegverplichting',
  'bedenktermijn',
  'finale kwijting',

  // Dienstverband
  'arbeidsovereenkomst',
  'bepaalde tijd',
  'onbepaalde tijd',
  'ketenregeling',
  'proeftijd',
  'uitzendbeding',
  'payrolling',
  'cao',

  // Ziekte en re-integratie
  'bedrijfsarts',
  're-integratie',
  'arbeidsongeschikt',
  'loondoorbetaling',
  'deskundigenoordeel',
  'Wet verbetering poortwachter',
  'ziektewet',

  // Conflict en procedure
  'concurrentiebeding',
  'relatiebeding',
  'boetebeding',
  'verbetertraject',
  'officiële waarschuwing',
  'kort geding',
  'dagvaarding',
  'vervaltermijn',
  'WW-uitkering',
];

export const EMPLOYMENT_KEYTERMS_EN: readonly string[] = [
  'settlement agreement',
  'summary dismissal',
  'transition payment',
  'non-compete clause',
  'occupational physician',
  'reintegration',
  'notice period',
  'fixed-term contract',
  'collective labour agreement',
  'subdistrict court',
];

export function keytermsFor(language: 'nl' | 'en'): readonly string[] {
  return language === 'nl' ? EMPLOYMENT_KEYTERMS_NL : EMPLOYMENT_KEYTERMS_EN;
}
