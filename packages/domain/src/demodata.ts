/**
 * Is dit een gezaaide demo-intake of een echt gesprek?
 *
 * ## Waarom dit bestaat
 *
 * Seed en productie staan in dezelfde tabellen. Ze zijn aan niets te onderscheiden: dezelfde
 * kolommen, dezelfde statussen, dezelfde vorm. Dat heeft in de praktijk een ronde gekost — een
 * gezaaide systeemregel is aangezien voor bewijs dat er in een echt gesprek een uitspraak was
 * overgeslagen, en de conclusie die daaruit volgde was onjuist. Zie RISICOS.md risico 23.
 *
 * Het gaat niet alleen om onderzoek. Een advocaat die het dashboard opent, ziet demo-intakes
 * tussen de echte staan met dezelfde urgentie en dezelfde volledigheid. Wie daarop een
 * werkvoorraad inschat, telt zaken mee die niet bestaan.
 *
 * ## Waarom aan het UUID en niet aan een kolom
 *
 * Een kolom `is_demo` zou eerlijker zijn, maar die vraagt een migratie, moet op elke tabel
 * terugkomen, en moet door elke schrijfweg correct worden gezet — inclusief de wegen die er
 * later bij komen. Dat is meer oppervlak om fout te doen dan het probleem groot is.
 *
 * De seed gebruikt vaste UUID's met een herkenbare vorm: `…-0000-4000-a000-…`. Bij een echte
 * v4-UUID zijn die middengroepen willekeurig. De kans dat een echt gesprek deze vorm treft, is
 * ruwweg één op tienduizend miljard: vier vaste nibbles voor `0000`, drie voor `000` na de
 * versie-`4`, en `a000` waarvan de variant-nibble al vastligt maar de drie erna niet.
 *
 * Dat is geen sluitend bewijs en het hoort geen beveiliging te dragen. Het is een aanwijzing
 * die goed genoeg is om "dit is demodata" te tonen en om een onderzoeker te behoeden voor de
 * fout die hierboven staat.
 *
 * ## Wat dit niet doet
 *
 * Het verwijdert niets en het verbergt niets. Demodata hoort zichtbaar te zijn als demodata,
 * niet afwezig — een dashboard dat stilletjes rijen weglaat is een nieuw soort onbetrouwbaar.
 */

/**
 * De vorm die `supabase/seed/demo-data.mjs` gebruikt voor elk vast id.
 *
 * `00000000-…` organisatie, `10000000-…` intakes, `20000000-…` sessies, `30000000-…` documenten,
 * `40000000-…` berichten. Alleen de middengroepen doen ertoe.
 */
const DEMO_VORM = /^[0-9a-f]{8}-0000-4000-a000-[0-9a-f]{12}$/i;

export function isDemoId(id: string | null | undefined): boolean {
  return typeof id === 'string' && DEMO_VORM.test(id);
}

/** Wat er bij een gemarkeerde rij hoort te staan. Kort, want het is een aantekening. */
export const DEMO_LABEL = 'demo';
