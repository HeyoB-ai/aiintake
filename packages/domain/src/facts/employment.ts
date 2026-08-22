import { z } from 'zod';
import {
  IsoDateSchema,
  MoneySchema,
  always,
  anyOf,
  factEquals,
  factIn,
  factKnown,
  type FactCatalog,
  type FactCategoryDefinition,
  type FactDefinition,
} from './catalog';

/**
 * Arbeidsrecht — 17 conditionele categorieën.
 *
 * De volgorde hieronder is de *default*. De QuestionPlanner mag ervan afwijken zodra
 * urgentie of een conditioneel blok dat rechtvaardigt: wie een VSO met tekendeadline
 * noemt, krijgt het VSO-blok vóór de algemene profielvragen.
 */

export const EMPLOYMENT_CATEGORIES: readonly FactCategoryDefinition[] = [
  { key: 'trigger', order: 1, label: { nl: 'Aanleiding', en: 'Trigger' } },
  { key: 'employment_basics', order: 2, label: { nl: 'Dienstverband', en: 'Employment' } },
  { key: 'employer', order: 3, label: { nl: 'Werkgever', en: 'Employer' } },
  { key: 'compensation', order: 4, label: { nl: 'Salaris', en: 'Compensation' } },
  {
    key: 'vso',
    order: 5,
    label: { nl: 'Vaststellingsovereenkomst', en: 'Settlement agreement' },
    relevantWhen: factEquals('termination_route', 'settlement_agreement'),
  },
  {
    key: 'summary_dismissal',
    order: 6,
    label: { nl: 'Ontslag op staande voet', en: 'Summary dismissal' },
    relevantWhen: factEquals('termination_route', 'summary_dismissal'),
  },
  {
    key: 'fixed_term',
    order: 7,
    label: { nl: 'Tijdelijk contract', en: 'Fixed-term contract' },
    relevantWhen: factEquals('contract_type', 'fixed_term'),
  },
  {
    key: 'wage_dispute',
    order: 8,
    label: { nl: 'Loonconflict', en: 'Wage dispute' },
    relevantWhen: anyOf(
      factEquals('wage_payment_stopped', true),
      factEquals('primary_issue', 'wage'),
    ),
  },
  { key: 'performance', order: 9, label: { nl: 'Functioneren', en: 'Performance' } },
  {
    key: 'illness',
    order: 10,
    label: { nl: 'Ziekte en re-integratie', en: 'Illness and reintegration' },
  },
  { key: 'procedure', order: 11, label: { nl: 'Lopende procedure', en: 'Ongoing proceedings' } },
  { key: 'deadlines', order: 12, label: { nl: 'Termijnen', en: 'Deadlines' } },
  { key: 'non_compete', order: 13, label: { nl: 'Bedingen', en: 'Clauses' } },
  { key: 'client_goal', order: 14, label: { nl: 'Doel van de cliënt', en: 'Client objective' } },
  { key: 'documents', order: 15, label: { nl: 'Documenten', en: 'Documents' } },
  { key: 'legal_funding', order: 16, label: { nl: 'Financiering', en: 'Funding' } },
  { key: 'client_identity', order: 17, label: { nl: 'Contactgegevens', en: 'Contact details' } },
];

const TERMINATION_ROUTES = [
  'settlement_agreement',
  'summary_dismissal',
  'uwv_procedure',
  'court_dissolution',
  'resignation',
  'fixed_term_expiry',
  'probation_dismissal',
  'none_yet',
  'other',
] as const;

const CONTRACT_TYPES = [
  'permanent',
  'fixed_term',
  'temp_agency',
  'payroll',
  'zzp',
  'other',
] as const;

const PRIMARY_ISSUES = [
  'dismissal',
  'settlement_agreement',
  'wage',
  'illness',
  'conflict',
  'non_compete',
  'other',
] as const;

const CLIENT_GOALS = [
  'keep_job',
  'better_settlement',
  'contest_dismissal',
  'get_paid',
  'leave_quickly',
  'advice_only',
  'unknown',
] as const;

export const EMPLOYMENT_FACTS: readonly FactDefinition[] = [
  // ---------------------------------------------------------------- trigger
  {
    key: 'primary_issue',
    category: 'trigger',
    valueType: 'enum',
    enumValues: PRIMARY_ISSUES,
    priority: 100,
    required: true,
    criteriaWeight: 40,
    label: { nl: 'Kern van het probleem', en: 'Core issue' },
    hint: {
      nl: 'Laat de cliënt in eigen woorden vertellen wat er speelt.',
      en: 'Let the client describe in their own words what is going on.',
    },
    validator: z.enum(PRIMARY_ISSUES),
  },
  {
    key: 'termination_route',
    category: 'trigger',
    valueType: 'enum',
    enumValues: TERMINATION_ROUTES,
    priority: 95,
    required: true,
    criteriaWeight: 30,
    urgencyRelevant: true,
    label: { nl: 'Wijze van beëindiging', en: 'Termination route' },
    hint: {
      nl: 'Hoe wil de werkgever het dienstverband beëindigen — of is dat al gebeurd?',
      en: 'How does the employer intend to end the employment — or has that already happened?',
    },
    validator: z.enum(TERMINATION_ROUTES),
  },

  // ------------------------------------------------------- employment_basics
  {
    key: 'contract_type',
    category: 'employment_basics',
    valueType: 'enum',
    enumValues: CONTRACT_TYPES,
    priority: 80,
    required: true,
    criteriaWeight: 15,
    label: { nl: 'Type dienstverband', en: 'Contract type' },
    hint: {
      nl: 'Vast of tijdelijk contract, uitzend, payroll of zzp.',
      en: 'Permanent or fixed-term, agency, payroll or self-employed.',
    },
    validator: z.enum(CONTRACT_TYPES),
  },
  {
    key: 'employment_start_date',
    category: 'employment_basics',
    valueType: 'date',
    priority: 78,
    required: true,
    label: { nl: 'Datum in dienst', en: 'Employment start date' },
    hint: {
      nl: 'Sinds wanneer werkt de cliënt er? Een jaartal is genoeg als de datum onbekend is.',
      en: 'Since when has the client worked there? A year suffices if the exact date is unknown.',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'hours_per_week',
    category: 'employment_basics',
    valueType: 'number',
    priority: 55,
    required: false,
    label: { nl: 'Uren per week', en: 'Hours per week' },
    hint: { nl: 'Contractuele uren per week.', en: 'Contractual hours per week.' },
    validator: z.number().positive().max(80),
  },
  {
    key: 'job_title',
    category: 'employment_basics',
    valueType: 'string',
    priority: 50,
    required: false,
    label: { nl: 'Functie', en: 'Job title' },
    hint: { nl: 'Welke functie vervult de cliënt?', en: 'What is the client’s role?' },
    validator: z.string().min(1).max(200),
  },

  // --------------------------------------------------------------- employer
  {
    key: 'employer_name',
    category: 'employer',
    valueType: 'string',
    priority: 70,
    required: true,
    /** Nodig voor de conflictcheck vóór afronding (§8.6 architectuurdoc). */
    criteriaWeight: 25,
    label: { nl: 'Naam werkgever', en: 'Employer name' },
    hint: {
      nl: 'Naam van de werkgever — nodig om te controleren of het kantoor de wederpartij al bijstaat.',
      en: 'Employer name — needed to check the firm is not already acting for the counterparty.',
    },
    validator: z.string().min(1).max(200),
  },
  {
    key: 'employer_size',
    category: 'employer',
    valueType: 'enum',
    enumValues: ['micro', 'small', 'medium', 'large', 'unknown'],
    priority: 35,
    required: false,
    label: { nl: 'Omvang werkgever', en: 'Employer size' },
    hint: { nl: 'Ongeveer hoeveel mensen werken er?', en: 'Roughly how many people work there?' },
    validator: z.enum(['micro', 'small', 'medium', 'large', 'unknown']),
  },
  {
    key: 'collective_agreement',
    category: 'employer',
    valueType: 'string',
    priority: 30,
    required: false,
    label: { nl: 'Toepasselijke cao', en: 'Collective agreement' },
    hint: {
      nl: 'Geldt er een cao, en zo ja welke?',
      en: 'Does a collective agreement apply, and which?',
    },
    validator: z.string().max(200),
  },

  // ------------------------------------------------------------ compensation
  {
    key: 'gross_monthly_salary',
    category: 'compensation',
    valueType: 'number',
    priority: 75,
    required: true,
    criteriaWeight: 20,
    label: { nl: 'Bruto maandsalaris', en: 'Gross monthly salary' },
    hint: {
      nl: 'Bruto per maand, exclusief vakantiegeld. Een schatting mag.',
      en: 'Gross per month, excluding holiday allowance. An estimate is fine.',
    },
    validator: MoneySchema,
  },
  {
    key: 'salary_includes_variable',
    category: 'compensation',
    valueType: 'boolean',
    priority: 25,
    required: false,
    label: { nl: 'Variabele beloning', en: 'Variable pay' },
    hint: {
      nl: 'Is er bonus, provisie of dertiende maand?',
      en: 'Is there bonus, commission or 13th month?',
    },
    validator: z.boolean(),
  },

  // -------------------------------------------------------------------- vso
  {
    key: 'vso_received_date',
    category: 'vso',
    valueType: 'date',
    priority: 92,
    required: true,
    urgencyRelevant: true,
    relevantWhen: factEquals('termination_route', 'settlement_agreement'),
    label: { nl: 'Datum ontvangst VSO', en: 'Settlement agreement received on' },
    hint: {
      nl: 'Wanneer heeft de cliënt de vaststellingsovereenkomst gekregen?',
      en: 'When did the client receive the settlement agreement?',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'vso_signing_deadline',
    category: 'vso',
    valueType: 'date',
    priority: 99,
    required: true,
    urgencyRelevant: true,
    criteriaWeight: 10,
    relevantWhen: factEquals('termination_route', 'settlement_agreement'),
    label: { nl: 'Tekendeadline VSO', en: 'Signing deadline' },
    hint: {
      nl: 'Tot wanneer heeft de cliënt van de werkgever de tijd om te tekenen?',
      en: 'By when does the employer want the client to sign?',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'vso_signed',
    category: 'vso',
    valueType: 'boolean',
    /**
     * Vóór de deadline vragen: is er al getekend, dan verandert het hele gesprek van
     * onderhandeling naar herstel. Daarom hoogste prioriteit van het VSO-blok.
     */
    priority: 98,
    required: true,
    urgencyRelevant: true,
    criteriaWeight: 35,
    relevantWhen: factEquals('termination_route', 'settlement_agreement'),
    label: { nl: 'VSO al ondertekend', en: 'Settlement agreement already signed' },
    hint: {
      nl: 'Heeft de cliënt al getekend? Zo ja, wanneer precies.',
      en: 'Has the client signed already? If so, exactly when.',
    },
    validator: z.boolean(),
  },
  {
    key: 'vso_signed_date',
    category: 'vso',
    valueType: 'date',
    priority: 90,
    required: false,
    urgencyRelevant: true,
    relevantWhen: factEquals('vso_signed', true),
    label: { nl: 'Datum ondertekening', en: 'Date signed' },
    hint: {
      nl: 'Op welke datum is getekend? Bepaalt of de bedenktermijn nog loopt.',
      en: 'On what date was it signed? Determines whether the reflection period still runs.',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'vso_proposed_end_date',
    category: 'vso',
    valueType: 'date',
    priority: 65,
    required: true,
    relevantWhen: factEquals('termination_route', 'settlement_agreement'),
    label: { nl: 'Voorgestelde einddatum', en: 'Proposed end date' },
    hint: {
      nl: 'Per welke datum zou het dienstverband eindigen volgens de VSO?',
      en: 'On what date would the employment end under the agreement?',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'vso_severance_offered',
    category: 'vso',
    valueType: 'number',
    priority: 62,
    required: true,
    criteriaWeight: 20,
    relevantWhen: factEquals('termination_route', 'settlement_agreement'),
    label: { nl: 'Aangeboden vergoeding', en: 'Severance offered' },
    hint: {
      nl: 'Welk bedrag biedt de werkgever aan?',
      en: 'What amount is the employer offering?',
    },
    validator: MoneySchema,
  },
  {
    key: 'vso_employer_pressure',
    category: 'vso',
    valueType: 'boolean',
    priority: 88,
    required: false,
    urgencyRelevant: true,
    relevantWhen: factEquals('termination_route', 'settlement_agreement'),
    label: { nl: 'Druk tot onmiddellijk tekenen', en: 'Pressure to sign immediately' },
    hint: {
      nl: 'Dringt de werkgever aan op onmiddellijke ondertekening?',
      en: 'Is the employer pressing for immediate signature?',
    },
    validator: z.boolean(),
  },

  // ------------------------------------------------------- summary_dismissal
  {
    key: 'summary_dismissal_date',
    category: 'summary_dismissal',
    valueType: 'date',
    priority: 99,
    required: true,
    urgencyRelevant: true,
    relevantWhen: factEquals('termination_route', 'summary_dismissal'),
    label: { nl: 'Datum ontslag op staande voet', en: 'Date of summary dismissal' },
    hint: {
      nl: 'Wanneer is de cliënt op staande voet ontslagen? De vervaltermijn is kort.',
      en: 'When was the client summarily dismissed? The limitation period is short.',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'summary_dismissal_reason_given',
    category: 'summary_dismissal',
    valueType: 'string',
    priority: 85,
    required: true,
    relevantWhen: factEquals('termination_route', 'summary_dismissal'),
    label: { nl: 'Opgegeven reden', en: 'Stated reason' },
    hint: {
      nl: 'Welke reden gaf de werkgever, en is die schriftelijk bevestigd?',
      en: 'What reason did the employer give, and was it confirmed in writing?',
    },
    validator: z.string().min(1).max(2000),
  },
  {
    key: 'summary_dismissal_contested',
    category: 'summary_dismissal',
    valueType: 'boolean',
    priority: 84,
    required: true,
    urgencyRelevant: true,
    relevantWhen: factEquals('termination_route', 'summary_dismissal'),
    label: { nl: 'Al bezwaar gemaakt', en: 'Already contested' },
    hint: {
      nl: 'Heeft de cliënt al schriftelijk geprotesteerd tegen het ontslag?',
      en: 'Has the client already protested the dismissal in writing?',
    },
    validator: z.boolean(),
  },

  // ------------------------------------------------------------- fixed_term
  {
    key: 'fixed_term_end_date',
    category: 'fixed_term',
    valueType: 'date',
    priority: 68,
    required: true,
    urgencyRelevant: true,
    relevantWhen: factEquals('contract_type', 'fixed_term'),
    label: { nl: 'Einddatum contract', en: 'Contract end date' },
    hint: { nl: 'Wanneer loopt het contract af?', en: 'When does the contract expire?' },
    validator: IsoDateSchema,
  },
  {
    key: 'fixed_term_contract_count',
    category: 'fixed_term',
    valueType: 'number',
    priority: 60,
    required: false,
    relevantWhen: factEquals('contract_type', 'fixed_term'),
    label: { nl: 'Aantal opeenvolgende contracten', en: 'Number of consecutive contracts' },
    hint: {
      nl: 'Het hoeveelste tijdelijke contract is dit bij deze werkgever?',
      en: 'How many fixed-term contracts has the client had with this employer?',
    },
    validator: z.number().int().positive().max(20),
  },
  {
    key: 'fixed_term_notice_received',
    category: 'fixed_term',
    valueType: 'boolean',
    priority: 64,
    required: false,
    urgencyRelevant: true,
    relevantWhen: factEquals('contract_type', 'fixed_term'),
    label: { nl: 'Aanzegging ontvangen', en: 'Notice of non-renewal received' },
    hint: {
      nl: 'Heeft de werkgever schriftelijk aangezegd of het contract wordt verlengd?',
      en: 'Has the employer given written notice about renewal?',
    },
    validator: z.boolean(),
  },

  // ----------------------------------------------------------- wage_dispute
  {
    key: 'wage_payment_stopped',
    category: 'wage_dispute',
    valueType: 'boolean',
    priority: 93,
    required: false,
    urgencyRelevant: true,
    criteriaWeight: 15,
    label: { nl: 'Loonbetaling gestopt', en: 'Wage payments stopped' },
    hint: {
      nl: 'Wordt het loon nog betaald? Zo nee, sinds wanneer niet.',
      en: 'Is salary still being paid? If not, since when.',
    },
    validator: z.boolean(),
  },
  {
    key: 'wage_unpaid_since',
    category: 'wage_dispute',
    valueType: 'date',
    priority: 90,
    required: false,
    urgencyRelevant: true,
    relevantWhen: factEquals('wage_payment_stopped', true),
    label: { nl: 'Onbetaald sinds', en: 'Unpaid since' },
    hint: {
      nl: 'Vanaf welke maand is er niet meer betaald?',
      en: 'From which month has payment stopped?',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'wage_amount_claimed',
    category: 'wage_dispute',
    valueType: 'number',
    priority: 58,
    required: false,
    relevantWhen: factEquals('wage_payment_stopped', true),
    label: { nl: 'Openstaand bedrag', en: 'Amount outstanding' },
    hint: {
      nl: 'Hoeveel loon staat er ongeveer open?',
      en: 'Roughly how much salary is outstanding?',
    },
    validator: MoneySchema,
  },

  // ------------------------------------------------------------ performance
  {
    key: 'previous_warnings',
    category: 'performance',
    valueType: 'boolean',
    priority: 66,
    required: true,
    criteriaWeight: 15,
    label: { nl: 'Eerdere waarschuwingen', en: 'Previous warnings' },
    hint: {
      nl: 'Zijn er eerder officiële waarschuwingen of een verbetertraject geweest?',
      en: 'Have there been formal warnings or a performance improvement plan?',
    },
    validator: z.boolean(),
  },
  {
    key: 'improvement_plan',
    category: 'performance',
    valueType: 'boolean',
    priority: 52,
    required: false,
    relevantWhen: factEquals('previous_warnings', true),
    label: { nl: 'Verbetertraject', en: 'Improvement plan' },
    hint: {
      nl: 'Is er een verbetertraject aangeboden, en is dat vastgelegd?',
      en: 'Was an improvement plan offered, and was it documented?',
    },
    validator: z.boolean(),
  },
  {
    key: 'workplace_conflict',
    category: 'performance',
    valueType: 'boolean',
    priority: 48,
    required: false,
    label: { nl: 'Arbeidsconflict', en: 'Workplace conflict' },
    hint: {
      nl: 'Is er een conflict met een leidinggevende of collega voorafgegaan?',
      en: 'Was there a conflict with a manager or colleague beforehand?',
    },
    validator: z.boolean(),
  },

  // ---------------------------------------------------------------- illness
  {
    key: 'currently_ill',
    category: 'illness',
    valueType: 'boolean',
    priority: 87,
    required: true,
    urgencyRelevant: true,
    criteriaWeight: 25,
    specialCategory: true,
    label: { nl: 'Momenteel ziek gemeld', en: 'Currently on sick leave' },
    hint: {
      nl: 'Is de cliënt op dit moment ziek gemeld? Dit raakt het opzegverbod.',
      en: 'Is the client currently on sick leave? This affects the dismissal prohibition.',
    },
    validator: z.boolean(),
  },
  {
    key: 'sick_since',
    category: 'illness',
    valueType: 'date',
    priority: 72,
    required: false,
    specialCategory: true,
    relevantWhen: factEquals('currently_ill', true),
    label: { nl: 'Ziek sinds', en: 'Ill since' },
    hint: {
      nl: 'Sinds wanneer is de cliënt ziek? Bepaalt de fase van de re-integratie.',
      en: 'Since when has the client been ill? Determines the reintegration stage.',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'occupational_doctor_involved',
    category: 'illness',
    valueType: 'boolean',
    priority: 61,
    required: false,
    specialCategory: true,
    relevantWhen: factKnown('currently_ill'),
    label: { nl: 'Bedrijfsarts betrokken', en: 'Occupational physician involved' },
    hint: {
      nl: 'Is de cliënt bij de bedrijfsarts geweest, en wat was het oordeel?',
      en: 'Has the client seen the occupational physician, and what was the assessment?',
    },
    validator: z.boolean(),
  },
  {
    key: 'reintegration_dispute',
    category: 'illness',
    valueType: 'boolean',
    priority: 57,
    required: false,
    specialCategory: true,
    relevantWhen: factEquals('occupational_doctor_involved', true),
    label: { nl: 'Geschil over re-integratie', en: 'Reintegration dispute' },
    hint: {
      nl: 'Is er onenigheid over de re-integratieverplichtingen?',
      en: 'Is there disagreement about reintegration obligations?',
    },
    validator: z.boolean(),
  },

  // -------------------------------------------------------------- procedure
  {
    key: 'legal_proceedings_started',
    category: 'procedure',
    valueType: 'boolean',
    priority: 96,
    required: true,
    urgencyRelevant: true,
    criteriaWeight: 30,
    label: { nl: 'Procedure gestart', en: 'Proceedings started' },
    hint: {
      nl: 'Loopt er al een procedure — dagvaarding, kort geding of UWV-aanvraag?',
      en: 'Are proceedings already running — summons, injunction or UWV application?',
    },
    validator: z.boolean(),
  },
  {
    key: 'court_deadline',
    category: 'procedure',
    valueType: 'date',
    priority: 100,
    required: false,
    urgencyRelevant: true,
    relevantWhen: factEquals('legal_proceedings_started', true),
    label: { nl: 'Proceduretermijn', en: 'Procedural deadline' },
    hint: {
      nl: 'Is er een zittingsdatum of reactietermijn? Dit bepaalt de urgentie.',
      en: 'Is there a hearing date or response deadline? This drives urgency.',
    },
    validator: IsoDateSchema,
  },
  {
    key: 'other_counsel_involved',
    category: 'procedure',
    valueType: 'boolean',
    priority: 76,
    required: true,
    criteriaWeight: 30,
    label: { nl: 'Andere rechtsbijstand betrokken', en: 'Other counsel involved' },
    hint: {
      nl: 'Staat er al een andere advocaat of jurist op de zaak?',
      en: 'Is another lawyer or legal adviser already acting?',
    },
    validator: z.boolean(),
  },

  // -------------------------------------------------------------- deadlines
  {
    key: 'response_deadline',
    category: 'deadlines',
    valueType: 'date',
    priority: 97,
    required: false,
    urgencyRelevant: true,
    label: { nl: 'Reactietermijn', en: 'Response deadline' },
    hint: {
      nl: 'Is er een datum waarop de cliënt moet reageren of tekenen?',
      en: 'Is there a date by which the client must respond or sign?',
    },
    validator: IsoDateSchema,
  },

  // ------------------------------------------------------------- non_compete
  {
    key: 'non_compete_clause',
    category: 'non_compete',
    valueType: 'boolean',
    priority: 45,
    required: false,
    label: { nl: 'Concurrentiebeding', en: 'Non-compete clause' },
    hint: {
      nl: 'Staat er een concurrentie- of relatiebeding in het contract?',
      en: 'Does the contract contain a non-compete or non-solicitation clause?',
    },
    validator: z.boolean(),
  },
  {
    key: 'new_employer_lined_up',
    category: 'non_compete',
    valueType: 'boolean',
    priority: 42,
    required: false,
    relevantWhen: factEquals('non_compete_clause', true),
    label: { nl: 'Nieuwe werkgever in beeld', en: 'New employer lined up' },
    hint: {
      nl: 'Heeft de cliënt al zicht op ander werk? Dat maakt het beding acuut.',
      en: 'Does the client have another job in prospect? That makes the clause acute.',
    },
    validator: z.boolean(),
  },

  // ------------------------------------------------------------ client_goal
  {
    key: 'client_goal',
    category: 'client_goal',
    valueType: 'enum',
    enumValues: CLIENT_GOALS,
    priority: 82,
    required: true,
    criteriaWeight: 25,
    label: { nl: 'Doel van de cliënt', en: 'Client objective' },
    hint: {
      nl: 'Wat wil de cliënt bereiken — baan behouden, betere regeling, of snel weg?',
      en: 'What does the client want — keep the job, a better deal, or leave quickly?',
    },
    validator: z.enum(CLIENT_GOALS),
  },

  // -------------------------------------------------------------- documents
  {
    key: 'has_employment_contract',
    category: 'documents',
    valueType: 'boolean',
    priority: 54,
    required: false,
    label: { nl: 'Arbeidsovereenkomst beschikbaar', en: 'Employment contract available' },
    hint: {
      nl: 'Heeft de cliënt de arbeidsovereenkomst bij de hand om te uploaden?',
      en: 'Does the client have the employment contract at hand to upload?',
    },
    validator: z.boolean(),
  },
  {
    key: 'has_correspondence',
    category: 'documents',
    valueType: 'boolean',
    priority: 53,
    required: false,
    label: { nl: 'Correspondentie beschikbaar', en: 'Correspondence available' },
    hint: {
      nl: 'Is er correspondentie met de werkgever die relevant is?',
      en: 'Is there relevant correspondence with the employer?',
    },
    validator: z.boolean(),
  },

  // ---------------------------------------------------------- legal_funding
  {
    key: 'legal_expenses_insurance',
    category: 'legal_funding',
    valueType: 'boolean',
    priority: 40,
    required: false,
    criteriaWeight: 20,
    label: { nl: 'Rechtsbijstandverzekering', en: 'Legal expenses insurance' },
    hint: {
      nl: 'Heeft de cliënt een rechtsbijstandverzekering of vakbondslidmaatschap?',
      en: 'Does the client have legal expenses insurance or union membership?',
    },
    validator: z.boolean(),
  },

  // --------------------------------------------------------- client_identity
  {
    key: 'client_full_name',
    category: 'client_identity',
    valueType: 'string',
    priority: 74,
    required: true,
    label: { nl: 'Naam cliënt', en: 'Client name' },
    hint: { nl: 'Volledige naam van de cliënt.', en: 'Full name of the client.' },
    validator: z.string().min(1).max(200),
  },
  {
    key: 'client_email',
    category: 'client_identity',
    valueType: 'string',
    priority: 73,
    required: true,
    label: { nl: 'E-mailadres', en: 'Email address' },
    hint: {
      nl: 'E-mailadres waarop het kantoor kan reageren.',
      en: 'Email address the firm can reply to.',
    },
    validator: z.string().email().max(320),
  },
  {
    key: 'client_phone',
    category: 'client_identity',
    valueType: 'string',
    priority: 44,
    required: false,
    label: { nl: 'Telefoonnummer', en: 'Phone number' },
    hint: { nl: 'Telefoonnummer voor spoedcontact.', en: 'Phone number for urgent contact.' },
    validator: z.string().min(6).max(40),
  },
];

export const EMPLOYMENT_CATALOG: FactCatalog = {
  practiceArea: 'employment',
  categories: EMPLOYMENT_CATEGORIES,
  facts: EMPLOYMENT_FACTS,
};

/** Feiten die onder art. 9 AVG vallen. Nooit in applicatielogs, korte retentie. */
export const SPECIAL_CATEGORY_FACT_KEYS: readonly string[] = EMPLOYMENT_FACTS.filter(
  (f) => f.specialCategory,
).map((f) => f.key);

export { always, anyOf, factEquals, factIn, factKnown };
