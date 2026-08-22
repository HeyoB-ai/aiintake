import type { IntakeRule, IntakeTemplate } from '../schemas/template';
import { allOf, factEquals } from './catalog';

/**
 * Het arbeidsrecht-template en de urgentieregels.
 *
 * Twee dingen staan hier bewust náást de feitcatalogus in plaats van erin.
 *
 * Het **template** zegt wanneer een intake af is: welke feiten minimaal binnen moeten
 * zijn, hoe lang het gesprek maximaal duurt, en wanneer de planner moet gaan afronden.
 * Dat zijn productbeslissingen, geen eigenschappen van een feit.
 *
 * De **regels** zijn de bron van waarheid voor urgentie (§6). Ze zijn deterministisch:
 * gegeven dezelfde feiten volgt hetzelfde niveau, zonder model in de lus. Dat is geen
 * technische voorkeur maar een productvereiste — een advocaat die om 8 uur 's ochtends
 * een CRITICAL ziet, moet kunnen navragen wélke regel dat veroorzaakte. "Het model vond
 * van wel" is bij een vervaltermijn geen antwoord.
 *
 * ## Wat deze regels niet zijn
 *
 * Dit is geen juridisch advies en geen termijnbewaking. Het is een signaalfunctie die
 * bepaalt wie er bovenaan de stapel komt te liggen. De termijnen hieronder zijn de
 * bekende hoofdregels uit het Nederlandse arbeidsrecht en staan er om te sorteren, niet
 * om op te varen — vandaar dat elk label eindigt bij een constatering en niet bij een
 * conclusie, en dat de samenvatting de disclaimer uit ai-output.ts meedraagt.
 *
 * De marges zijn krap gekozen. Een vervaltermijn van twee maanden wordt hier al na
 * zesenveertig dagen kritiek: een advocaat die dan pas begint, heeft nog twee weken. Het
 * alternatief — melden op de dag zelf — is precies te laat om nog iets te betekenen.
 */

export const EMPLOYMENT_TEMPLATE: IntakeTemplate = {
  key: 'employment-nl',
  practiceArea: 'employment',
  version: 1,

  /**
   * Extra must-haves die dít kantoor wil, bovenop wat de catalogus al verplicht stelt.
   *
   * Leeg, en dat is geen omissie. Hier stond eerst een lijst van acht sleutels die
   * stuk voor stuk al `required: true` waren in de feitcatalogus. Twee bronnen voor
   * dezelfde waarheid, waarvan er één niets deed — en dat soort configuratie is
   * gevaarlijker dan geen configuratie, want iemand gaat hem ooit aanpassen in de
   * veronderstelling dat het effect heeft.
   *
   * De verdeling is nu: de **catalogus** bepaalt wat er standaard nodig is, per feit en
   * per voorwaarde (de VSO-feiten zijn verplicht zodra het VSO-blok relevant is, en
   * anders niet). Het **template** is de kantoorspecifieke laag erbovenop, voor een
   * kantoor dat bijvoorbeeld altijd een telefoonnummer wil. De must-have-verzameling is
   * de vereniging van die twee, doorsneden met wat voor dit gesprek relevant is.
   */
  requiredFactKeys: [],

  /**
   * 0,75 en niet 1,0. Volledigheid is een gewogen score over relevante feiten; eisen dat
   * álles binnen is, betekent doorvragen over randgevallen terwijl de advocaat allang
   * genoeg weet. De score telt bovendien `unknown` mee als beantwoord — "dat weet ik
   * niet" is een antwoord, en er nog drie keer naar vragen is precies het gedrag dat een
   * intake als een formulier laat aanvoelen.
   */
  completionThreshold: 0.75,

  /**
   * Harde bovengrens. Daarna stelt de planner alleen nog openstaande must-haves en
   * rondt daarna af, ook als de score onder de drempel blijft. Een gesprek dat blijft
   * doorvragen tot alles compleet is, wordt door de cliënt beëindigd in plaats van door
   * ons — en dan is er niets.
   */
  maxTurns: 40,

  /**
   * Vanaf hier wordt de vermoeidheidsaftrek actief: optionele feiten zakken in score,
   * must-haves niet. Twintig beurten is ruwweg acht minuten gesprek.
   */
  fatigueAfterTurns: 20,
};

/**
 * Urgentieregels, van hard naar zacht.
 *
 * `plannerBoost` is geen urgentie maar nieuwsgierigheid: hoeveel extra gewicht krijgen
 * de feiten die deze regel kunnen bevestigen of uitsluiten. Een regel die op een
 * onbekend datumveld wacht, moet dat veld naar voren trekken — anders ontdek je de
 * deadline in beurt dertig.
 */
export const EMPLOYMENT_RULES: readonly IntakeRule[] = [
  {
    key: 'vso_deadline_imminent',
    level: 'CRITICAL',
    label: {
      nl: 'Tekendeadline vaststellingsovereenkomst binnen 7 dagen',
      en: 'Settlement agreement signing deadline within 7 days',
    },
    when: { kind: 'deadlineWithin', key: 'vso_signing_deadline', days: 7 },
    plannerBoost: 40,
  },
  {
    key: 'court_deadline_imminent',
    level: 'CRITICAL',
    label: {
      nl: 'Zittings- of proceduretermijn binnen 14 dagen',
      en: 'Court or procedural deadline within 14 days',
    },
    when: { kind: 'deadlineWithin', key: 'court_deadline', days: 14 },
    plannerBoost: 40,
  },
  {
    key: 'summary_dismissal_window_closing',
    level: 'CRITICAL',
    label: {
      nl: 'Ontslag op staande voet meer dan 46 dagen geleden — vervaltermijn nadert',
      en: 'Summary dismissal more than 46 days ago — limitation window closing',
    },
    // De vervaltermijn van art. 7:686a lid 4 BW is twee maanden. Bij 46 dagen resteert
    // er nog een kleine twee weken; dat is het laatste moment waarop een advocaat nog
    // iets kan doen zonder haast als excuus.
    when: { kind: 'elapsedSince', key: 'summary_dismissal_date', days: 46 },
    plannerBoost: 35,
  },
  {
    key: 'summary_dismissal',
    level: 'HIGH',
    label: {
      nl: 'Ontslag op staande voet — geen loon, geen WW zolang het standhoudt',
      en: 'Summary dismissal — no wages, no benefits while it stands',
    },
    when: factEquals('termination_route', 'summary_dismissal'),
    plannerBoost: 30,
  },
  {
    key: 'vso_deadline_near',
    level: 'HIGH',
    label: {
      nl: 'Tekendeadline vaststellingsovereenkomst binnen 14 dagen',
      en: 'Settlement agreement signing deadline within 14 days',
    },
    when: { kind: 'deadlineWithin', key: 'vso_signing_deadline', days: 14 },
    plannerBoost: 25,
  },
  {
    key: 'vso_already_signed',
    level: 'HIGH',
    label: {
      nl: 'Vaststellingsovereenkomst al getekend — bedenktijd mogelijk nog open',
      en: 'Settlement agreement already signed — reflection period may still apply',
    },
    // De wettelijke bedenktijd is veertien dagen (art. 7:670b BW). Al getekend is dus
    // niet per definitie te laat, en juist daarom moet dit meteen zichtbaar zijn.
    when: factEquals('vso_signed', true),
    plannerBoost: 30,
  },
  {
    key: 'wage_stopped',
    level: 'HIGH',
    label: {
      nl: 'Loonbetaling gestopt — geen inkomen',
      en: 'Wage payments stopped — no income',
    },
    when: factEquals('wage_payment_stopped', true),
    plannerBoost: 20,
  },
  {
    key: 'non_compete_blocks_new_job',
    level: 'HIGH',
    label: {
      nl: 'Concurrentiebeding blokkeert een concrete nieuwe baan',
      en: 'Non-compete clause blocking a concrete new job',
    },
    when: allOf(factEquals('non_compete_clause', true), factEquals('new_employer_lined_up', true)),
    plannerBoost: 25,
  },
  {
    key: 'proceedings_started',
    level: 'HIGH',
    label: {
      nl: 'Procedure loopt al',
      en: 'Legal proceedings already under way',
    },
    when: factEquals('legal_proceedings_started', true),
    plannerBoost: 20,
  },
  {
    key: 'response_deadline_near',
    level: 'MEDIUM',
    label: {
      nl: 'Reactietermijn richting werkgever binnen 7 dagen',
      en: 'Response deadline towards employer within 7 days',
    },
    when: { kind: 'deadlineWithin', key: 'response_deadline', days: 7 },
    plannerBoost: 20,
  },
  {
    key: 'fixed_term_ending',
    level: 'MEDIUM',
    label: {
      nl: 'Tijdelijk contract loopt binnen 30 dagen af',
      en: 'Fixed-term contract ends within 30 days',
    },
    when: { kind: 'deadlineWithin', key: 'fixed_term_end_date', days: 30 },
    plannerBoost: 15,
  },
  {
    key: 'reintegration_dispute',
    level: 'MEDIUM',
    label: {
      nl: 'Conflict over re-integratie tijdens ziekte',
      en: 'Dispute over reintegration during illness',
    },
    when: allOf(factEquals('currently_ill', true), factEquals('reintegration_dispute', true)),
    plannerBoost: 15,
  },
];

/**
 * Welke feiten kan deze regel nog bevestigen of uitsluiten?
 *
 * De planner gebruikt dit om `plannerBoost` toe te kennen aan feiten die nog onbekend
 * zijn. Een regel die al is afgegaan hoeft niets meer naar voren te trekken; een regel
 * die op een onbekend datumveld wacht, des te meer.
 */
export function ruleFactKeys(rule: IntakeRule): readonly string[] {
  const uit = new Set<string>();
  const loop = (c: unknown): void => {
    if (!c || typeof c !== 'object') return;
    const k = c as { kind?: string; key?: string; conditions?: unknown[]; condition?: unknown };
    if (k.key) uit.add(k.key);
    if (k.conditions) for (const sub of k.conditions) loop(sub);
    if (k.condition) loop(k.condition);
  };
  loop(rule.when);
  return [...uit];
}
