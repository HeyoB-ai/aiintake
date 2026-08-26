import type { Language } from './enums';

/**
 * Het wanhoopspad.
 *
 * ## Waarom dit bestaat
 *
 * De doelgroep bestaat uit mensen die net hun baan kwijt zijn. Een deel daarvan zit in
 * financiële nood of erger. Zegt iemand tijdens een intake iets dat op wanhoop wijst, dan
 * deed het systeem het slechtste wat het kon doen: doorgaan naar vraag zeven.
 *
 * ## Wat er gebeurt als dit afgaat
 *
 * Vier dingen, en ze horen bij elkaar:
 *
 *  1. **Het gesprek vertraagt.** De vraag van de planner vervalt voor deze beurt. Niet
 *     uitstellen tot later in dezelfde beurt — vervállen. Een erkenning met een vraag
 *     erachter is geen erkenning.
 *  2. **De assistent erkent zonder door te vragen.** Geen "kunt u daar iets meer over
 *     vertellen". Dit is een intake bij een advocatenkantoor, geen hulpverleningsgesprek,
 *     en doorvragen op wanhoop door een systeem dat niet kan helpen is schadelijk.
 *  3. **Het kantoor ziet het als urgent.** Een risicovlag op CRITICAL, in het dossier.
 *  4. **Er wordt verwezen naar echte hulp**, en nadrukkelijk niet naar de advocaat. Een
 *     advocaat is geen hulpverlener en een intakeassistent al helemaal niet.
 *
 * ## De verwijzingen zijn nagezocht, niet onthouden
 *
 * Een verzonnen nummer in dit pad is de ergste fout die dit product kan maken. Beide zijn
 * op 26 augustus 2026 geverifieerd op de site van de dienst zelf:
 *
 * - **113 Zelfmoordpreventie** — https://www.113.nl vermeldt "Bel gratis 113" en een chat
 *   op https://www.113.nl/chat. Het nummer 113 is het gratis nummer; op de pagina staan
 *   geen openingstijden, dus die beloven we ook niet.
 * - **Geldfit** — https://geldfit.nl/contact/bellen/ vermeldt 0800-8115, gratis en
 *   anoniem, bereikbaar maandag tot en met vrijdag van 9:00 tot 21:00, ook via chat en
 *   WhatsApp. Een initiatief van overheid en gemeenten.
 *
 * Die openingstijden staan er met opzet bij in de gesproken tekst. Iemand die 's avonds om
 * elf uur belt en niemand krijgt, is slechter af dan iemand die weet dat hij morgen moet
 * bellen.
 *
 * **Voor de deploy hoort het kantoor deze verwijzingen te bevestigen.** Ze staan hier als
 * constante en niet per organisatie instelbaar, en dat is een bewuste beperking van de
 * eerste versie: één verkeerde waarde per kantoor is erger dan één waarde die iedereen
 * kan nazien.
 */

export type WanhoopSoort = 'geen' | 'acuut' | 'geldzorgen';

export interface Verwijzing {
  readonly naam: string;
  readonly telefoon: string;
  readonly web: string;
  /** Wat er over bereikbaarheid bekend is. Leeg laten is beter dan iets beloven. */
  readonly bereikbaarheid: string | null;
}

export const VERWIJZING_ACUUT: Verwijzing = {
  naam: '113 Zelfmoordpreventie',
  telefoon: '113',
  web: '113.nl',
  bereikbaarheid: null,
};

export const VERWIJZING_GELDZORGEN: Verwijzing = {
  naam: 'Geldfit',
  telefoon: '0800-8115',
  web: 'geldfit.nl',
  bereikbaarheid: 'maandag tot en met vrijdag van negen uur tot negen uur',
};

/** De vlag die in het dossier terechtkomt. */
export const WANHOOP_REGEL_ACUUT = 'client.acute_distress';
export const WANHOOP_REGEL_GELD = 'client.financial_distress';

export interface WanhoopReactie {
  /** Wat de assistent zegt. Eén blok, en er komt géén vraag achteraan. */
  readonly tekst: string;
  readonly regelKey: string;
  readonly niveau: 'HIGH' | 'CRITICAL';
  readonly label: string;
  readonly verwijzing: Verwijzing;
}

/**
 * De gesproken reactie, volledig vast.
 *
 * Net als bij de erkenning formuleert het model hier niets. Het bepaalt alleen de soort;
 * deze tekst is van ons. Bij wanhoop is dat geen stijlkeuze maar een veiligheidseis: een
 * gegenereerde zin kan een belofte bevatten die niemand kan waarmaken, of een oordeel over
 * de zaak, of een vraag — en alle drie zijn hier schadelijk.
 *
 * Geen enkele variant benoemt een gevoel van de cliënt, en geen enkele stelt een vraag.
 */
export function wanhoopReactie(
  soort: WanhoopSoort,
  language: Language = 'nl',
): WanhoopReactie | null {
  if (soort === 'geen') return null;

  if (soort === 'acuut') {
    const v = VERWIJZING_ACUUT;
    return {
      tekst:
        language === 'en'
          ? // Geen "day and night": op 113.nl stonden geen openingstijden, dus beloven we
            // ze niet. Dezelfde regel als in de Nederlandse variant.
            `I am going to pause here. I am an AI assistant and I cannot help with this. ` +
            `${v.naam} is there for this: call ${v.telefoon}, free, or chat at ${v.web}. ` +
            `Whenever you want, we can continue with your case.`
          : `Ik stop hier even. Ik ben een AI-assistent en hier kan ik u niet mee helpen. ` +
            `${v.naam} is hiervoor bereikbaar: bel gratis ${v.telefoon}, of chat via ${v.web}. ` +
            `Wanneer u wilt, gaan we verder met uw zaak.`,
      regelKey: WANHOOP_REGEL_ACUUT,
      niveau: 'CRITICAL',
      label: 'Cliënt uitte acute nood tijdens de intake',
      verwijzing: v,
    };
  }

  const v = VERWIJZING_GELDZORGEN;
  return {
    tekst:
      language === 'en'
        ? `I am going to pause here. For money worries there is ${v.naam}: call ${v.telefoon} free, ` +
          `${v.bereikbaarheid}. They are independent and it costs nothing. ` +
          `Whenever you want, we can continue.`
        : `Ik stop hier even. Voor geldzorgen bestaat ${v.naam}: bel gratis ${v.telefoon}, ` +
          `${v.bereikbaarheid}. Dat is onafhankelijk en het kost niets. ` +
          `Wanneer u wilt, gaan we verder.`,
    regelKey: WANHOOP_REGEL_GELD,
    niveau: 'HIGH',
    label: 'Cliënt uitte financiële nood tijdens de intake',
    verwijzing: v,
  };
}

/** Alle gesproken varianten, zodat een test ze kan nalopen. */
export const ALLE_WANHOOP_TEKSTEN: readonly string[] = (['acuut', 'geldzorgen'] as const).flatMap(
  (s) => [wanhoopReactie(s, 'nl')!.tekst, wanhoopReactie(s, 'en')!.tekst],
);
