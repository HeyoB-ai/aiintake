/**
 * Het demo-decor: Van Dijk Arbeidsrecht en vijf afgeronde intakes.
 *
 * Dit is data, geen SQL, en dat is een keuze met een reden. De seed moet langs twee
 * wegen naartoe kunnen:
 *
 *   - rechtstreeks op Postgres (`pnpm db:check`, lokale embedded database)
 *   - via PostgREST met de secret key (`pnpm db:seed`, gehost project)
 *
 * Die tweede weg bestaat omdat een gehost Supabase-project geen losse SQL accepteert;
 * daar heb je anders een databasewachtwoord voor nodig dat verder nergens voor dient.
 * Zou de seed als .sql-bestand blijven bestaan, dan waren er twee beschrijvingen van
 * hetzelfde decor nodig — en die lopen na de eerste wijziging uit elkaar.
 *
 * Transcripten, samenvattingen en documenten komen in Fase 7, zodra het cold path en de
 * samenvattingsgenerator bestaan om ze te produceren. Een handgeschreven "samenvatting"
 * hier zou een kwaliteit suggereren die het systeem nog niet levert.
 */

export const ORG_ID = '00000000-0000-4000-a000-000000000001';

const intakeId = (n) => `10000000-0000-4000-a000-00000000000${n}`;

/** ISO-datum, n dagen vanaf vandaag. De seed heeft relatieve datums nodig: een
 *  tekendeadline die in het verleden ligt maakt de urgentiedemo onzinnig. */
export function isoDate(offsetDays, today = new Date()) {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function hoursAgo(hours, now = new Date()) {
  return new Date(now.getTime() - hours * 3600_000).toISOString();
}

export function buildSeed(now = new Date()) {
  const organizations = [
    {
      id: ORG_ID,
      slug: 'vandijk-arbeidsrecht',
      name: 'Van Dijk Arbeidsrecht',
      default_language: 'nl',
      provider_config: {
        // Tot de bakeoff gedraaid is, blijft dit de null-provider.
        avatar: 'null',
        stt: 'deepgram',
        tts: 'cartesia',
        llmHot: 'claude-haiku-4-5-20251001',
        llmCold: 'claude-sonnet-5',
      },
      session_limits: {
        maxSessionMinutes: 25,
        inactivityTimeoutSeconds: 90,
        maxConcurrentSessions: 5,
        monthlyBudgetEurCents: 50_000,
        fallbackToChatOnBudget: true,
      },
      intake_criteria: {
        minMonthlySalary: null,
        acceptIfOtherCounsel: false,
        autoFlagFrom: 'HIGH',
      },
      retention_policy: {
        mediaRetentionHours: 0,
        transcriptRetentionDays: 365,
        documentRetentionDays: 365,
        visualSignalRetentionHours: 0,
        rejectedIntakeRetentionDays: 90,
      },
      // De cliëntcamera wordt niet gepubliceerd; zie ADR-0004.
      publish_client_video: false,
      privacy_policy_version: 'v1',
      ai_disclosure_version: 'v1',
    },
  ];

  const prompt_templates = [
    {
      key: 'conversation.employment.nl',
      purpose: 'conversation',
      description: 'Hot path — formuleert de gesproken zin. Platte tekst, nooit JSON.',
    },
    {
      key: 'extraction.employment',
      purpose: 'extraction',
      description: 'Cold path — feiten met confidence en citaat uit het transcript.',
    },
    {
      key: 'urgency.employment',
      purpose: 'urgency',
      description: 'Cold path — signaleert; de rule engine beslist.',
    },
    {
      key: 'document.analysis',
      purpose: 'document',
      description: 'Cold path — documentinhoud als data, nooit als instructie.',
    },
    {
      key: 'summary.employment',
      purpose: 'summary',
      description: 'Cold path — samenvatting met verwijzing per bewering.',
    },
  ];

  const scenarios = [
    {
      n: 1,
      client: 'Sanne Bakker',
      subject: 'Vaststellingsovereenkomst met tekendeadline',
      urgency: 'HIGH',
      completeness: 0.85,
    },
    {
      n: 2,
      client: 'Mehmet Yilmaz',
      subject: 'Ontslag op staande voet',
      urgency: 'CRITICAL',
      completeness: 0.78,
    },
    {
      n: 3,
      client: 'Petra de Groot',
      subject: 'Loon niet betaald sinds juni',
      urgency: 'MEDIUM',
      completeness: 0.72,
    },
    {
      n: 4,
      client: 'Johan Vermeer',
      subject: 'Geschil over re-integratie',
      urgency: 'MEDIUM',
      completeness: 0.69,
    },
    {
      n: 5,
      client: 'Aisha Nkemdirim',
      subject: 'Tijdelijk contract loopt af',
      urgency: 'LOW',
      completeness: 0.91,
    },
  ];

  const intakes = scenarios.map((s) => ({
    id: intakeId(s.n),
    organization_id: ORG_ID,
    practice_area: 'employment',
    language: 'nl',
    status: 'READY_FOR_REVIEW',
    client_name: s.client,
    subject: s.subject,
    urgency_level: s.urgency,
    completeness: s.completeness,
    template_key: 'employment.v1',
    template_version: 1,
    conflict_check_status: 'clear',
    created_at: hoursAgo(s.n * 9, now),
    completed_at: hoursAgo(s.n * 9 - 0.25, now),
  }));

  /**
   * Feiten mét herkomst. De constraint case_facts_traceable weigert een vastgesteld
   * feit zonder source_ref, en de seed hoort zich aan dezelfde regel te houden als de
   * applicatie — anders test de seed niets.
   */
  const fact = (n, key, value, value_type, evidence, extra = {}) => ({
    organization_id: ORG_ID,
    intake_id: intakeId(n),
    key,
    value,
    value_type,
    status: 'confirmed',
    confidence: 0.9,
    source: 'client_statement',
    source_ref: 'seed',
    evidence_quote: evidence,
    ...extra,
  });

  const case_facts = [
    // 1 — VSO met tekendeadline (HIGH)
    fact(1, 'primary_issue', 'settlement_agreement', 'enum', 'vaststellingsovereenkomst', {
      confidence: 0.97,
    }),
    fact(1, 'termination_route', 'settlement_agreement', 'enum', 'vaststellingsovereenkomst', {
      confidence: 0.96,
    }),
    fact(1, 'contract_type', 'permanent', 'enum', 'vast contract', { confidence: 0.92 }),
    fact(1, 'gross_monthly_salary', 3800, 'number', '3800 euro bruto'),
    fact(1, 'vso_signed', false, 'boolean', 'nog niet getekend', { confidence: 0.95 }),
    fact(1, 'vso_signing_deadline', isoDate(3, now), 'date', 'vrijdag tekenen', {
      confidence: 0.88,
    }),
    fact(1, 'currently_ill', false, 'boolean', 'niet ziek', { confidence: 0.85 }),
    // "Niet vastgesteld" is een uitkomst, geen leegte. Vandaar expliciet in de seed.
    {
      organization_id: ORG_ID,
      intake_id: intakeId(1),
      key: 'previous_warnings',
      value: null,
      value_type: 'boolean',
      status: 'unknown',
      confidence: 0,
      source: 'client_statement',
      source_ref: null,
      evidence_quote: null,
    },

    // 2 — Ontslag op staande voet (CRITICAL)
    fact(2, 'primary_issue', 'dismissal', 'enum', 'op staande voet', { confidence: 0.98 }),
    fact(2, 'termination_route', 'summary_dismissal', 'enum', 'op staande voet', {
      confidence: 0.97,
    }),
    fact(2, 'summary_dismissal_date', isoDate(-5, now), 'date', 'vorige week woensdag', {
      confidence: 0.93,
    }),
    fact(2, 'summary_dismissal_contested', false, 'boolean', 'nog geen bezwaar'),

    // 3 — Loonconflict (MEDIUM)
    fact(3, 'primary_issue', 'wage', 'enum', 'loon niet betaald', { confidence: 0.95 }),
    fact(3, 'wage_payment_stopped', true, 'boolean', 'geen loon meer', { confidence: 0.96 }),

    // 4 — Ziekte en re-integratie (MEDIUM)
    fact(4, 'primary_issue', 'illness', 'enum', 're-integratie', { confidence: 0.94 }),
    fact(4, 'currently_ill', true, 'boolean', 'ziek gemeld', { confidence: 0.95 }),
    fact(4, 'occupational_doctor_involved', true, 'boolean', 'bedrijfsarts', { confidence: 0.91 }),

    // 5 — Tijdelijk contract (LOW)
    fact(5, 'primary_issue', 'dismissal', 'enum', 'contract loopt af', { confidence: 0.88 }),
    fact(5, 'contract_type', 'fixed_term', 'enum', 'tijdelijk contract', { confidence: 0.95 }),
    fact(5, 'fixed_term_contract_count', 3, 'number', 'derde contract', { confidence: 0.86 }),
  ];

  /** detected_by = 'rule': de regel is de bron van waarheid, AI mag alleen signaleren. */
  const risk_flags = [
    {
      organization_id: ORG_ID,
      intake_id: intakeId(1),
      rule_key: 'vso_deadline_within_14_days',
      level: 'HIGH',
      label: 'Tekendeadline vaststellingsovereenkomst binnen 14 dagen',
      detected_by: 'rule',
      source_ref: 'seed',
      independently_confirmed: true,
    },
    {
      organization_id: ORG_ID,
      intake_id: intakeId(2),
      rule_key: 'summary_dismissal',
      level: 'CRITICAL',
      label: 'Ontslag op staande voet — korte vervaltermijn',
      detected_by: 'rule',
      source_ref: 'seed',
      independently_confirmed: true,
    },
    {
      organization_id: ORG_ID,
      intake_id: intakeId(3),
      rule_key: 'wage_payment_stopped',
      level: 'MEDIUM',
      label: 'Loonbetaling gestopt',
      detected_by: 'rule',
      source_ref: 'seed',
      independently_confirmed: true,
    },
    {
      organization_id: ORG_ID,
      intake_id: intakeId(4),
      rule_key: 'reintegration_dispute',
      level: 'MEDIUM',
      label: 'Mogelijk geschil over re-integratieverplichtingen',
      detected_by: 'rule',
      source_ref: 'seed',
      independently_confirmed: false,
    },
  ];

  // Volgorde is niet vrij: foreign keys lopen van intakes naar organizations, en van
  // case_facts en risk_flags naar intakes.
  // `json` benoemt de jsonb-kolommen. Nodig voor het Postgres-transport: daar moet ook
  // een los getal of een boolean als JSON gecodeerd worden, want 3800 is geen geldige
  // jsonb-invoer maar "3800" wel. PostgREST doet die codering zelf.
  return [
    {
      table: 'organizations',
      rows: organizations,
      conflict: 'id',
      json: ['provider_config', 'session_limits', 'intake_criteria', 'retention_policy'],
    },
    { table: 'prompt_templates', rows: prompt_templates, conflict: 'key', json: [] },
    { table: 'intakes', rows: intakes, conflict: 'id', json: [] },
    { table: 'case_facts', rows: case_facts, conflict: 'intake_id,key', json: ['value'] },
    { table: 'risk_flags', rows: risk_flags, conflict: 'intake_id,rule_key', json: [] },
  ];
}
