import { notFound } from 'next/navigation';
import type { CaseFact, RiskFlag, UrgencyLevel } from '@intake/domain';
import type { DocumentItem, DossierState } from '@intake/ui';
import { createClient } from '@/lib/supabase/server';

/**
 * Alles wat de detailpagina nodig heeft, in één keer opgehaald.
 *
 * ## Geen organization_id-filter
 *
 * RLS levert alleen wat deze gebruiker mag zien. Een filter hier zou de indruk wekken dat
 * de grens in de applicatielaag ligt, en dat is precies de verwarring die je bij een
 * multi-tenant product niet wilt: dan gaat iemand op een dag een query schrijven zonder
 * filter en denkt dat het daarom fout is.
 *
 * ## Waarom parallel
 *
 * Zeven losse queries, tegelijk. Een advocaat moet in twee tot vijf minuten kunnen
 * besluiten; dan hoort de pagina niet zeven keer achter elkaar op de database te wachten.
 * De join op `users` voor de toegewezen behandelaar zit in de intake-query zelf.
 */

export interface IntakeDetail {
  readonly intake: {
    readonly id: string;
    readonly created_at: string;
    readonly completed_at: string | null;
    readonly client_name: string | null;
    readonly client_email: string | null;
    readonly client_phone: string | null;
    readonly subject: string | null;
    readonly practice_area: string;
    readonly language: string;
    readonly status: string;
    readonly urgency_level: UrgencyLevel | null;
    readonly completeness: number | null;
    readonly turn_count: number;
    readonly conflict_check_status: string;
    readonly assignee: { full_name: string | null; email: string } | null;
  };
  readonly dossier: DossierState;
  readonly documents: readonly DocumentItem[];
  readonly berichten: readonly {
    readonly id: string;
    readonly turn_index: number;
    readonly role: 'assistant' | 'client' | 'system';
    readonly content: string;
    readonly intended_content: string | null;
    readonly interrupted_at_char: number | null;
    readonly created_at: string;
  }[];
  readonly samenvatting: {
    readonly sections: Record<string, unknown>;
    readonly not_established: readonly string[];
    readonly grounding_ok: boolean;
    readonly ungrounded_claims: readonly string[];
    readonly created_at: string;
  } | null;
  readonly auditlog: readonly {
    readonly id: number;
    readonly action: string;
    readonly actor_type: string;
    readonly created_at: string;
    readonly actor: { full_name: string | null; email: string } | null;
  }[];
}

/** Bytes naar iets leesbaars; de UI-component verwacht een opgemaakte tekst. */
function omvang(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function documentType(mime: string): DocumentItem['type'] {
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  return 'doc';
}

/**
 * De analysestatus uit de database naar wat de component kent.
 *
 * `rejected` en `failed` gaan allebei naar `failed`: voor de lezer is het verschil dat het
 * bestand niet is gelezen, en waaróm staat in `rejection_reason`.
 */
function analyseStatus(status: string): DocumentItem['status'] {
  if (status === 'completed') return 'analyzed';
  if (status === 'failed' || status === 'rejected') return 'failed';
  return 'processing';
}

export async function laadIntake(id: string): Promise<IntakeDetail> {
  const supabase = await createClient();

  const [intakeRes, factsRes, flagsRes, docsRes, berichtenRes, samenvattingRes, auditRes] =
    await Promise.all([
      supabase
        .from('intakes')
        // Eén letterlijke string; de typeparser van supabase-js leest geen concatenatie.
        .select(
          'id, created_at, completed_at, client_name, client_email, client_phone, subject, practice_area, language, status, urgency_level, completeness, turn_count, conflict_check_status, assigned_to',
        )
        .eq('id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('case_facts')
        .select('key, value, value_type, status, confidence, source, source_ref, updated_at')
        .eq('intake_id', id)
        .order('key'),
      supabase
        .from('risk_flags')
        .select('rule_key, level, label, detected_by, source_ref, created_at, resolved_at')
        .eq('intake_id', id)
        .is('resolved_at', null),
      supabase
        .from('documents')
        .select(
          'id, filename, mime_type, size_bytes, analysis_status, rejection_reason, uploaded_at',
        )
        .eq('intake_id', id)
        .order('uploaded_at'),
      supabase
        .from('messages')
        .select('id, turn_index, role, content, intended_content, interrupted_at_char, created_at')
        .eq('intake_id', id)
        .order('turn_index'),
      supabase
        .from('summaries')
        .select('sections, not_established, grounding_ok, ungrounded_claims, created_at')
        .eq('intake_id', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('audit_log')
        .select('id, action, actor_type, actor_user_id, created_at')
        .eq('intake_id', id)
        .order('created_at', { ascending: false })
        .limit(50),
    ]);

  // Niet gevonden én geen toegang zien er via RLS hetzelfde uit, en dat is de bedoeling:
  // een 404 verraadt niet dat er bij een ánder kantoor een dossier met dit id bestaat.
  if (intakeRes.error || !intakeRes.data) notFound();

  /*
   * De namen van medewerkers apart ophalen.
   *
   * Kan ook met een ingebedde select (`assignee:users!fk(...)`), maar die koppelt de query
   * aan de naam van een foreign-keyconstraint en levert een type dat tussen object en
   * array zweeft. Eén extra query op een handvol id's is voorspelbaarder, en RLS beslist
   * hier net zo goed wie er zichtbaar is: staat een medewerker er niet in, dan valt de
   * regel terug op het actortype.
   */
  const intakeRij = intakeRes.data as unknown as Record<string, unknown>;
  const auditRijen = (auditRes.data ?? []) as {
    id: number;
    action: string;
    actor_type: string;
    actor_user_id: string | null;
    created_at: string;
  }[];

  const gebruikerIds = [
    ...new Set(
      [intakeRij['assigned_to'], ...auditRijen.map((r) => r.actor_user_id)].filter(
        (v): v is string => typeof v === 'string',
      ),
    ),
  ];

  const gebruikers = new Map<string, { full_name: string | null; email: string }>();
  if (gebruikerIds.length > 0) {
    const { data } = await supabase
      .from('users')
      .select('id, full_name, email')
      .in('id', gebruikerIds);
    for (const u of (data ?? []) as { id: string; full_name: string | null; email: string }[]) {
      gebruikers.set(u.id, { full_name: u.full_name, email: u.email });
    }
  }

  const facts = (factsRes.data ?? []).map((f): CaseFact => ({
    key: f.key,
    value: f.value,
    valueType: f.value_type,
    status: f.status,
    confidence: Number(f.confidence),
    source: f.source,
    sourceRef: f.source_ref,
    llmCallId: null,
    ...(f.updated_at ? { updatedAt: f.updated_at } : {}),
  }));

  const riskFlags = (flagsRes.data ?? []).map((r): RiskFlag => ({
    ruleKey: r.rule_key,
    level: r.level,
    label: r.label,
    detectedBy: r.detected_by,
    sourceRef: r.source_ref,
    ...(r.created_at ? { createdAt: r.created_at } : {}),
  }));

  const documents = (docsRes.data ?? []).map((d): DocumentItem => ({
    id: d.id,
    name: d.filename,
    type: documentType(d.mime_type),
    // Categoriseren op inhoud doet de analysepijplijn; hier is het bestand nog niet
    // ingedeeld en is "Bewijsstuk" eerlijker dan een gok op de bestandsnaam.
    category: 'Bewijsstuk',
    size: omvang(d.size_bytes),
    uploadedAt: new Date(d.uploaded_at).toLocaleString('nl-NL', {
      dateStyle: 'short',
      timeStyle: 'short',
    }),
    status: analyseStatus(d.analysis_status),
    summary: '',
    extractedFacts: [],
    ...(d.rejection_reason ? { failureReason: d.rejection_reason } : {}),
  }));

  const completeness = intakeRij['completeness'];

  return {
    intake: {
      ...(intakeRij as unknown as Omit<IntakeDetail['intake'], 'assignee'>),
      assignee: gebruikers.get(String(intakeRij['assigned_to'] ?? '')) ?? null,
    },
    dossier: {
      completeness:
        completeness === null || completeness === undefined ? null : Number(completeness),
      facts,
      riskFlags,
      // De geweigerde feiten leven in `llm_calls` en niet op de intake; die komen in een
      // volgende stap, samen met de promptversie per beurt.
      rejected: [],
    },
    documents,
    berichten: (berichtenRes.data ?? []) as IntakeDetail['berichten'],
    samenvatting: (samenvattingRes.data ?? null) as IntakeDetail['samenvatting'],
    auditlog: auditRijen.map((r) => ({
      id: r.id,
      action: r.action,
      actor_type: r.actor_type,
      created_at: r.created_at,
      actor: r.actor_user_id ? (gebruikers.get(r.actor_user_id) ?? null) : null,
    })),
  };
}

/**
 * Legt vast dat dit dossier is ingezien.
 *
 * Via een RPC en niet met een insert: `audit_log` heeft met opzet geen insert-policy, zodat
 * niemand een gebeurtenis met een gekozen actor of tijdstip kan neerzetten. Zie de
 * migratie 20260824090000.
 *
 * Mislukt het, dan blijft de pagina gewoon werken. Een advocaat die een dossier niet kan
 * openen omdat het log hapert, is een groter probleem dan een ontbrekende logregel — maar
 * het gaat wel naar de serverconsole, want stil verliezen mag niet.
 *
 * Meerdere keren aanroepen is veilig: de RPC ontdubbelt zelf op dezelfde medewerker en
 * hetzelfde dossier binnen vijf minuten. Dat is nodig omdat een browser zelf kan bepalen
 * hoe vaak hij een pagina ophaalt — op een iPhone leverde één bezoek er vier op, terwijl
 * Chromium er precies één doet. Zie migratie 20260824210000.
 */
export async function logInzage(id: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('log_intake_viewed', { p_intake_id: id });
  if (error) console.error(`intake.viewed niet gelogd voor ${id}: ${error.message}`);
}
