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

  /*
   * Het gesprek zelf, voor intake 1 en 2.
   *
   * Zonder transcript is de detailpagina niet te beoordelen: dan zie je feiten zonder de
   * woorden waaruit ze komen, en juist die herleidbaarheid is wat een advocaat nodig heeft
   * om binnen een paar minuten te kunnen besluiten.
   *
   * Twee van de vijf, niet alle vijf. Een dossier zonder transcript is een echte toestand —
   * een intake die net begonnen is heeft er nog geen — en de pagina hoort dat netjes te
   * tonen in plaats van leeg te blijven. Met vijf gevulde dossiers zou dat pad nooit
   * bekeken worden.
   */
  const bericht = (n, i, role, content, extra = {}) => ({
    // Vaste id's, zodat de seed idempotent is: opnieuw draaien hoort niets te verdubbelen.
    id: `40000000-0000-4000-a000-${String(n).padStart(6, '0')}${String(i).padStart(6, '0')}`,
    organization_id: ORG_ID,
    intake_id: intakeId(n),
    turn_index: i,
    role,
    content,
    created_at: hoursAgo(n * 9 - i * 0.02, now),
    ...extra,
  });

  const messages = [
    bericht(
      1,
      0,
      'assistant',
      'Goedemiddag. Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht. Ik ben geen ' +
        'advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen, zodat een ' +
        'advocaat van Van Dijk Arbeidsrecht uw zaak sneller kan beoordelen. Zelf geef ik ' +
        'geen juridisch advies. Kunt u vertellen wat er speelt en waarom u contact opneemt?',
    ),
    bericht(
      1,
      1,
      'client',
      'Mijn werkgever heeft me een vaststellingsovereenkomst gestuurd. Ik moet vrijdag ' +
        'tekenen, zeggen ze, anders vervalt het aanbod.',
    ),
    bericht(1, 2, 'assistant', 'Kunt u vertellen hoe dat gesprek met uw werkgever is gegaan?'),
    bericht(
      1,
      3,
      'client',
      'Er was al een tijd gedoe over mijn functioneren. Ik verdien 3800 euro bruto en ik ' +
        'heb een vast contract. Ik heb nog niets getekend.',
    ),
    // Een afgebroken beurt: de cliënt onderbrak de assistent. `intended_content` bewaart
    // wat er zou zijn gezegd, en dat is precies het verschil dat een advocaat moet kunnen
    // zien wanneer een antwoord raar aansluit op de vraag.
    bericht(1, 4, 'assistant', 'Heeft u eerder een waarschuwing', {
      intended_content: 'Heeft u eerder een waarschuwing of een verbetertraject gehad?',
      interrupted_at_char: 28,
      spoken_ms: 1400,
    }),
    bericht(1, 5, 'client', 'Nee, nooit iets op papier gehad.'),

    bericht(
      2,
      0,
      'assistant',
      'Goedemorgen. Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht. Ik ben geen ' +
        'advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen, zodat een ' +
        'advocaat van Van Dijk Arbeidsrecht uw zaak sneller kan beoordelen. Zelf geef ik ' +
        'geen juridisch advies. Kunt u vertellen wat er speelt en waarom u contact opneemt?',
    ),
    bericht(
      2,
      1,
      'client',
      'Ik ben op staande voet ontslagen. Ze zeggen dat ik geld heb weggenomen uit de kas, ' +
        'maar dat is niet waar.',
    ),
    bericht(2, 2, 'assistant', 'Wanneer heeft u dat te horen gekregen?'),
    bericht(2, 3, 'client', 'Afgelopen vrijdag, mondeling. Daarna kreeg ik een brief.'),
    bericht(2, 4, 'system', 'beurt overgeslagen — geen cliëntinhoud; hij blijft wachten'),
    bericht(2, 5, 'client', 'Ik zit sinds die dag ook ziek thuis, ik slaap er niet van.'),
  ];

  /**
   * De samenvatting, met een bronverwijzing per bewering.
   *
   * `not_established` is geen restje maar de kern van het product: wat er níét staat, is
   * wat de advocaat als eerste moet vragen. `grounding_ok` legt vast dat elke bewering aan
   * een beurt hangt.
   */
  const summaries = [
    {
      id: '20000000-0000-4000-a000-000000000001',
      organization_id: ORG_ID,
      intake_id: intakeId(1),
      sections: {
        situatie:
          'Cliënt heeft een vaststellingsovereenkomst ontvangen met een tekendeadline. ' +
          'Er speelde eerder een discussie over functioneren.',
        dienstverband: 'Vast contract, 3800 euro bruto per maand.',
        stand_van_zaken: 'Nog niets getekend.',
        bronnen: { situatie: 'turn-1', dienstverband: 'turn-3', stand_van_zaken: 'turn-3' },
      },
      not_established: [
        'Datum van indiensttreding',
        'Hoogte van de aangeboden beëindigingsvergoeding',
        'Of er een concurrentiebeding in het contract staat',
      ],
      grounding_ok: true,
      ungrounded_claims: [],
      created_at: hoursAgo(9, now),
    },
    {
      id: '20000000-0000-4000-a000-000000000002',
      organization_id: ORG_ID,
      intake_id: intakeId(2),
      sections: {
        situatie:
          'Cliënt is op staande voet ontslagen wegens een gestelde kasopname, en betwist ' +
          'die grond.',
        gezondheid: 'Cliënt meldt zich sinds de ontslagdatum ziek.',
        bronnen: { situatie: 'turn-1', gezondheid: 'turn-5' },
      },
      not_established: [
        'Of er een schriftelijke ontslagbrief met dringende reden is ontvangen',
        'Datum van indiensttreding',
        'Of het UWV al is ingeschakeld',
      ],
      grounding_ok: true,
      ungrounded_claims: [],
      created_at: hoursAgo(18, now),
    },
  ];

  /**
   * Documenten, met twee verschillende analysestatussen.
   *
   * `analysis_status` is betekenisvol: de pagina hoort geen feiten uit een document te
   * tonen zolang de analyse loopt. Met alleen voltooide documenten in de seed zou dat pad
   * nooit bekeken worden.
   */
  const documents = [
    {
      id: '30000000-0000-4000-a000-000000000001',
      organization_id: ORG_ID,
      intake_id: intakeId(1),
      filename: 'Vaststellingsovereenkomst.pdf',
      mime_type: 'application/pdf',
      storage_path: `${ORG_ID}/${intakeId(1)}/vso.pdf`,
      size_bytes: 318000,
      uploaded_by_role: 'client',
      analysis_status: 'completed',
      uploaded_at: hoursAgo(8.8, now),
    },
    {
      id: '30000000-0000-4000-a000-000000000002',
      organization_id: ORG_ID,
      intake_id: intakeId(2),
      filename: 'Ontslagbrief.pdf',
      mime_type: 'application/pdf',
      storage_path: `${ORG_ID}/${intakeId(2)}/ontslagbrief.pdf`,
      size_bytes: 121400,
      uploaded_by_role: 'client',
      analysis_status: 'processing',
      uploaded_at: hoursAgo(17.5, now),
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
    { table: 'messages', rows: messages, conflict: 'id', json: [] },
    { table: 'summaries', rows: summaries, conflict: 'id', json: ['sections'] },
    { table: 'documents', rows: documents, conflict: 'id', json: [] },
  ];
}
