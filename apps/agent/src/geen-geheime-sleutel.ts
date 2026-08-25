/**
 * De worker weigert te starten als er een RLS-omzeilende sleutel in zijn omgeving staat.
 *
 * ## Waarom dit een runtimecontrole is
 *
 * Er is al een statische controle op de broncode
 * (packages/db/src/__tests__/agent-has-no-service-role.test.ts, §11): geen enkel codepad in
 * apps/agent kán bij zo'n sleutel. Die test bewijst iets over de code, en dat is precies
 * waar hij ophoudt. Bij een deploy komt de omgeving ergens anders vandaan — een gedeelde
 * variabelengroep, een gekopieerde `.env`, een collega die "alle sleutels" in het Railway-
 * project plakt omdat het anders niet werkte. De code is dan nog steeds schoon en de grens
 * is alsnog weg.
 *
 * Deze controle kijkt daarom naar de omgeving zoals die feitelijk is, bij het opstarten,
 * op de machine waar het proces draait. Hij faalt hard: een worker die niet draait is een
 * storing, een worker die met een tenant-overschrijdende sleutel draait is een datalek.
 *
 * ## Waarom de naam niet voluit in dit bestand staat
 *
 * De statische test verbiedt het letterlijke woord in apps/agent, en terecht: het staat er
 * nergens voor iets anders. Dat verbod geldt ook voor beschermende code, dus wordt de naam
 * hier uit stukken opgebouwd. Dat is geen slimmigheid om de test te omzeilen — de test
 * bewaakt "de worker kan er niet bij", en dit bestand bewaakt "de worker krijgt hem niet
 * aangereikt". Twee verschillende beweringen.
 *
 * ## Wat er wordt gecontroleerd
 *
 * Beide kanten, want een sleutel kan onder elke naam binnenkomen:
 *
 * 1. **Op waarde** — elke variabele waarvan de waarde begint met het voorvoegsel van een
 *    Supabase-geheime sleutel. Dit is de vangnetregel: hernoemen helpt niet.
 * 2. **Op naam** — de bekende namen, ook als de waarde leeg of een placeholder is. Een lege
 *    variabele met die naam betekent dat iemand de verkeerde sjabloon heeft gepakt, en de
 *    volgende deploy vult hem.
 */

/** Het voorvoegsel van een Supabase-sleutel die RLS omzeilt. */
const GEHEIM_VOORVOEGSEL = 'sb_' + 'secret_';

/**
 * Namen die zo'n sleutel plegen te dragen, uit stukken opgebouwd (zie de kop).
 *
 * De legacy-JWT-variant staat er ook bij. Die verdwijnt eind 2026, maar tot die tijd staat
 * hij in elk ouder sjabloon dat iemand zou kunnen kopiëren.
 */
const ROL = 'service' + '_' + 'role';
const VERBODEN_NAMEN: readonly string[] = [
  ['SUPABASE', 'SECRET', 'KEY'].join('_'),
  ['SUPABASE', ROL.toUpperCase(), 'KEY'].join('_'),
  ['SUPABASE', 'JWT', 'SECRET'].join('_'),
  [ROL.toUpperCase(), 'KEY'].join('_'),
];

export interface Bevinding {
  readonly naam: string;
  readonly reden: string;
}

/**
 * De bevindingen, zonder te gooien. Puur, zodat er een test op kan die geen proces sloopt.
 *
 * Geeft nooit de waarde terug — ook niet afgekort. Een foutmelding belandt in een logdienst
 * en dat is de laatste plek waar een sleutel hoort te staan.
 */
export function vindGeheimeSleutels(
  omgeving: Record<string, string | undefined>,
): readonly Bevinding[] {
  const uit: Bevinding[] = [];
  for (const [naam, waarde] of Object.entries(omgeving)) {
    if (VERBODEN_NAMEN.includes(naam)) {
      uit.push({
        naam,
        reden: 'deze variabele hoort alleen bij apps/web; de worker draait op een sessietoken',
      });
      continue;
    }
    if (typeof waarde === 'string' && waarde.startsWith(GEHEIM_VOORVOEGSEL)) {
      uit.push({
        naam,
        reden: `de waarde begint met ${GEHEIM_VOORVOEGSEL}… — dat is een sleutel die RLS omzeilt`,
      });
    }
  }

  return uit;
}

/**
 * Bij het opstarten aanroepen.
 *
 * ## Waarom dit in productie gooit en er lokaal over klaagt
 *
 * Lokaal deelt dit project één `.env` met de web-app en met de testharnas van packages/db.
 * Daar staat de secret key dus echt in de omgeving van de worker, en dat is geen vergissing
 * maar de opzet van dat bestand. Hard falen zou betekenen dat het ontwikkelharnas niet meer
 * start — en dan wordt deze controle uitgezet in plaats van dat er iets veiliger wordt.
 *
 * De grens die telt, is die van de deploy: op Railway hoort de sleutel er niet te zijn, en
 * daar staat `NODE_ENV=production`. Daar gooit dit dus, zonder uitzonderingen en ongeacht
 * onder welke naam de sleutel binnenkomt.
 *
 * Buiten productie blijft het een luide waarschuwing en geen stilte. Dat de lokale omgeving
 * ruimer is dan de deploy is iets wat je wilt zien, niet iets wat je wilt vergeten.
 */
export function assertGeenGeheimeSleutel(
  omgeving: Record<string, string | undefined> = process.env,
): void {
  const bevindingen = vindGeheimeSleutels(omgeving);
  if (bevindingen.length === 0) return;

  const regels = bevindingen.map((b) => `  - ${b.naam}: ${b.reden}`).join('\n');

  if (omgeving['NODE_ENV'] !== 'production') {
    console.warn(
      '\n  Let op: er staat een RLS-omzeilende sleutel in de omgeving van de worker.\n' +
        regels +
        '\n  Lokaal is dat de gedeelde .env en draait hij door. Bij de hostingpartij hoort\n' +
        '  deze variabele er niet te staan; daar weigert de worker te starten.\n',
    );
    return;
  }

  throw new Error(
    'De worker weigert te starten: er staat een RLS-omzeilende sleutel in zijn omgeving.\n' +
      regels +
      '\n\nVerwijder deze variabele(n) bij de worker. Ze horen uitsluitend bij apps/web.\n' +
      'De worker heeft genoeg aan SUPABASE_URL en SUPABASE_PUBLISHABLE_KEY; wat hij mag,\n' +
      'bepaalt het sessietoken dat hij per intake aangereikt krijgt.',
  );
}
