import { formatCompleteness, URGENCY_STYLES } from '@intake/ui';
import type { IntakeStatus, UrgencyLevel } from '@intake/domain';
import { requireUser } from '@/lib/auth';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Dashboard — Intake' };

/**
 * Het dashboard. Desktop-first: de advocaat moet in 2–5 minuten kunnen beslissen,
 * dus de kaarten en de urgentie staan bovenaan en alles daaronder is verdieping.
 *
 * Fase 0 levert de lijst en de rolcontext. De intakedetailpagina met samenvatting,
 * feiten, tijdlijn en de review-acties komt in Fase 3, zodra het cold path er is om
 * die velden te vullen.
 */

interface IntakeRow {
  id: string;
  created_at: string;
  client_name: string | null;
  subject: string | null;
  practice_area: string;
  urgency_level: UrgencyLevel | null;
  completeness: number | null;
  status: IntakeStatus;
  assigned_to: string | null;
}

const STATUS_LABEL: Record<IntakeStatus, string> = {
  NEW: 'Nieuw',
  IN_PROGRESS: 'Loopt',
  READY_FOR_REVIEW: 'Te beoordelen',
  MORE_INFO_REQUESTED: 'Meer info gevraagd',
  ACCEPTED: 'Geaccepteerd',
  REJECTED: 'Afgewezen',
  REFERRED: 'Doorverwezen',
  NEEDS_HUMAN_CHECK: 'Controle vereist',
};

export default async function DashboardPage() {
  const user = await requireUser();

  if (user.memberships.length === 0) {
    return (
      <EmptyState
        title="Nog geen kantoor gekoppeld"
        body="Uw account is nog niet aan een organisatie gekoppeld. Neem contact op met de beheerder van uw kantoor."
      />
    );
  }

  const supabase = await createClient();
  // Geen organization_id-filter nodig: RLS levert alleen intakes van kantoren waar
  // deze gebruiker lid van is. Een filter hier zou de indruk wekken dat de grens in
  // de applicatielaag ligt, en dat is precies de verwarring die je niet wilt.
  const { data, error } = await supabase
    .from('intakes')
    .select(
      'id, created_at, client_name, subject, practice_area, urgency_level, completeness, status, assigned_to',
    )
    .order('created_at', { ascending: false })
    .limit(100);

  const intakes = (data ?? []) as IntakeRow[];

  const counts = {
    nieuw: intakes.filter((i) => i.status === 'NEW' || i.status === 'IN_PROGRESS').length,
    urgent: intakes.filter((i) => i.urgency_level === 'HIGH' || i.urgency_level === 'CRITICAL')
      .length,
    teBeoordelen: intakes.filter((i) => i.status === 'READY_FOR_REVIEW').length,
    geaccepteerd: intakes.filter((i) => i.status === 'ACCEPTED').length,
    afgewezen: intakes.filter((i) => i.status === 'REJECTED').length,
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Intakes</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
          De assistent verzamelt en signaleert. Elke juridische beoordeling blijft bij u.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Nieuw" value={counts.nieuw} />
        <StatCard label="Mogelijk urgent" value={counts.urgent} accent />
        <StatCard label="Te beoordelen" value={counts.teBeoordelen} />
        <StatCard label="Geaccepteerd" value={counts.geaccepteerd} />
        <StatCard label="Afgewezen" value={counts.afgewezen} />
      </div>

      {error ? (
        <EmptyState
          title="Kon de intakes niet laden"
          body="Er ging iets mis bij het ophalen. Probeer het opnieuw of neem contact op met de beheerder."
        />
      ) : intakes.length === 0 ? (
        <EmptyState
          title="Nog geen intakes"
          body="Zodra een cliënt de intakepagina van uw kantoor doorloopt, verschijnt de intake hier."
        />
      ) : (
        <IntakeTable rows={intakes} />
      )}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{
        borderColor: 'var(--border)',
        background: accent && value > 0 ? 'var(--urgency-high-bg)' : 'var(--paper)',
      }}
    >
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </div>
    </div>
  );
}

function IntakeTable({ rows }: { rows: IntakeRow[] }) {
  return (
    <div
      className="overflow-x-auto rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--paper)' }}
    >
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: 'var(--border)' }}>
            <Th>Datum</Th>
            <Th>Cliënt</Th>
            <Th>Onderwerp</Th>
            <Th>Rechtsgebied</Th>
            <Th>Urgentie</Th>
            <Th>Volledigheid</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-b last:border-0"
              style={{ borderColor: 'var(--border)' }}
            >
              <Td>{new Date(row.created_at).toLocaleDateString('nl-NL')}</Td>
              <Td>{row.client_name ?? '—'}</Td>
              <Td>{row.subject ?? '—'}</Td>
              <Td>{row.practice_area === 'employment' ? 'Arbeidsrecht' : row.practice_area}</Td>
              <Td>
                {row.urgency_level ? (
                  <span
                    className="rounded px-2 py-0.5 text-xs font-medium"
                    style={{
                      color: URGENCY_STYLES[row.urgency_level].fg,
                      background: URGENCY_STYLES[row.urgency_level].bg,
                    }}
                    // Urgentie is nooit een vaststelling — de volledige formulering
                    // hangt aan het element in plaats van de tabel te laten uitdijen.
                    title={`Mogelijk urgente termijn — menselijke beoordeling vereist`}
                  >
                    {URGENCY_STYLES[row.urgency_level].label.nl}
                  </span>
                ) : (
                  '—'
                )}
              </Td>
              <Td>{formatCompleteness(row.completeness)}</Td>
              <Td>{STATUS_LABEL[row.status]}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2.5 text-xs font-medium" style={{ color: 'var(--muted)' }}>
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-3">{children}</td>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="rounded-lg border px-6 py-12 text-center"
      style={{ borderColor: 'var(--border)', background: 'var(--paper)' }}
    >
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
        {body}
      </p>
    </div>
  );
}
