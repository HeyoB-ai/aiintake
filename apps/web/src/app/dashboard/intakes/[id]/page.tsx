import Link from 'next/link';
import type { Metadata } from 'next';
import { TIJDZONE_TERUGVAL, datumTijd, datumTijdSeconden, type Tijdzone } from '@intake/domain';
import { requireUser } from '@/lib/auth';
import { laadIntake, logInzage } from './data';
import { DossierPaneel } from './dossier-paneel';
import { Transcript } from './transcript';

export const metadata: Metadata = { title: 'Intake — dossier' };

/**
 * Het intakedossier voor de advocaat.
 *
 * ## De volgorde is de functie
 *
 * Een advocaat moet hier in twee tot vijf minuten kunnen besluiten of de zaak interessant
 * en urgent is. Daarom staat bovenaan wat dat besluit draagt — de samenvatting en de
 * urgentiesignalen — en daaronder pas het materiaal waarmee het te controleren is: feiten,
 * tijdlijn, documenten, transcript, wat er ontbreekt, en wie wat wanneer heeft gedaan.
 *
 * Wat er níét bovenaan staat is net zo bewust. Geen advies, geen slaagkans, geen
 * aanbeveling. Het systeem verzamelt en signaleert; het oordeel is van de jurist, en een
 * scherm dat een richting suggereert maakt dat oordeel moeilijker in plaats van sneller.
 *
 * ## Waarom dit een servercomponent is
 *
 * De gegevens komen via RLS binnen. Zou de pagina ze in de browser ophalen, dan moet er een
 * anon-sleutel mee en hangt de afscherming aan het beleid alléén; nu hangt hij aan het
 * beleid én aan het feit dat de query nooit bij de client komt.
 */

const STATUS_LABEL: Record<string, string> = {
  NEW: 'Nieuw',
  IN_PROGRESS: 'Loopt',
  READY_FOR_REVIEW: 'Te beoordelen',
  MORE_INFO_REQUESTED: 'Meer info gevraagd',
  ACCEPTED: 'Geaccepteerd',
  REJECTED: 'Afgewezen',
  REFERRED: 'Doorverwezen',
  NEEDS_HUMAN_CHECK: 'Controle vereist',
};

const AUDIT_LABEL: Record<string, string> = {
  'intake.created': 'Intake aangemaakt',
  'intake.status_changed': 'Status gewijzigd',
  'intake.assigned': 'Toegewezen',
  'intake.viewed': 'Dossier ingezien',
  'intake.exported': 'Geëxporteerd',
  'session.started': 'Gesprek gestart',
  'session.ended': 'Gesprek beëindigd',
  'document.uploaded': 'Document geüpload',
  'document.downloaded': 'Document gedownload',
  'summary.generated': 'Samenvatting gemaakt',
  'summary.flagged_for_review': 'Samenvatting gemarkeerd',
  'consent.recorded': 'Toestemming vastgelegd',
};

const CONFLICT_LABEL: Record<string, string> = {
  pending: 'Nog niet gedaan',
  clear: 'Geen conflict',
  conflict: 'Conflict gevonden',
  waived: 'Bewust overgeslagen',
};

export default async function IntakeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  // De zone van het kantoor. Zie de toelichting in tijd.ts: dit draait op de server, en die
  // staat op UTC.
  const zone = user.memberships[0]?.timeZone ?? TIJDZONE_TERUGVAL;
  const { id } = await params;

  const detail = await laadIntake(id);
  // Ná het laden: mislukt het laden op RLS, dan is er niets ingezien en hoort er ook niets
  // in het log te staan.
  await logInzage(id);

  const { intake, dossier, documents, berichten, samenvatting, auditlog } = detail;
  const secties = Object.entries(samenvatting?.sections ?? {}).filter(
    ([sleutel, waarde]) => sleutel !== 'bronnen' && typeof waarde === 'string',
  );
  const bronnen = (samenvatting?.sections['bronnen'] ?? {}) as Record<string, string>;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="text-sm underline-offset-2 hover:underline"
          style={{ color: 'var(--muted)' }}
        >
          ← Alle intakes
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {intake.client_name ?? 'Naam niet vastgelegd'}
          </h1>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            {intake.subject ?? 'Onderwerp nog niet bepaald'}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
          <Kerngegeven label="Status" waarde={STATUS_LABEL[intake.status] ?? intake.status} />
          <Kerngegeven label="Ontvangen" waarde={datumTijd(intake.created_at, zone)} />
          <Kerngegeven
            label="Behandelaar"
            waarde={intake.assignee?.full_name ?? intake.assignee?.email ?? 'Niet toegewezen'}
          />
          <Kerngegeven
            label="Conflictcheck"
            waarde={CONFLICT_LABEL[intake.conflict_check_status] ?? intake.conflict_check_status}
          />
          <Kerngegeven label="Beurten" waarde={String(intake.turn_count)} />
          <Kerngegeven
            label="Contact"
            waarde={intake.client_email ?? intake.client_phone ?? 'Niet vastgelegd'}
          />
        </dl>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px] xl:grid-cols-[1fr_420px]">
        <main className="min-w-0 space-y-6">
          {/* 1. Samenvatting — het eerste wat er gelezen wordt. */}
          <Blok titel="Samenvatting">
            {samenvatting === null ? (
              <Leeg>
                Er is nog geen samenvatting. Die wordt gemaakt zodra het gesprek is afgerond.
              </Leeg>
            ) : (
              <div className="space-y-4">
                {!samenvatting.grounding_ok && (
                  <p
                    className="rounded-lg border px-3 py-2 text-sm"
                    style={{
                      borderColor: 'var(--urgency-high)',
                      background: 'var(--urgency-high-bg)',
                      color: 'var(--urgency-high)',
                    }}
                  >
                    Niet elke bewering in deze samenvatting is aan een uitspraak van de cliënt te
                    koppelen. Lees hem met dat voorbehoud
                    {samenvatting.ungrounded_claims.length > 0
                      ? `: ${samenvatting.ungrounded_claims.join('; ')}`
                      : '.'}
                  </p>
                )}
                {secties.map(([sleutel, tekst]) => (
                  <div key={sleutel}>
                    <h3
                      className="text-xs font-medium uppercase tracking-wide"
                      style={{ color: 'var(--muted)' }}
                    >
                      {sleutel.replace(/_/g, ' ')}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed">{String(tekst)}</p>
                    {bronnen[sleutel] && (
                      // Herkomst per bewering. Zonder dit is een samenvatting een mening.
                      <p className="mt-1 font-mono text-xs" style={{ color: 'var(--muted)' }}>
                        bron: {bronnen[sleutel]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Blok>

          {/* 2. Ontbrekende informatie — wat de advocaat als eerste moet vragen. */}
          <Blok titel="Ontbrekende informatie">
            {!samenvatting || samenvatting.not_established.length === 0 ? (
              <Leeg>Niets als ontbrekend gemarkeerd.</Leeg>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {samenvatting.not_established.map((item) => (
                  <li key={item} className="flex gap-2">
                    <span aria-hidden style={{ color: 'var(--muted)' }}>
                      •
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </Blok>

          {/* 3. Tijdlijn: wat er wanneer gebeurde, los van wat er is gezegd. */}
          <Blok titel="Tijdlijn">
            <ol className="space-y-2 text-sm">
              <Moment tijd={intake.created_at} tekst="Intake gestart door de cliënt" zone={zone} />
              {documents.map((d) => (
                <Moment
                  key={d.id}
                  tijdTekst={d.uploadedAt}
                  tekst={`Document geüpload: ${d.name}`}
                  zone={zone}
                />
              ))}
              {intake.completed_at && (
                <Moment tijd={intake.completed_at} tekst="Gesprek afgerond" zone={zone} />
              )}
              {samenvatting && (
                <Moment tijd={samenvatting.created_at} tekst="Samenvatting gemaakt" zone={zone} />
              )}
            </ol>
          </Blok>

          {/* 4. Het transcript. Onderaan, want het is controlemateriaal en geen leeswerk. */}
          <Blok titel="Transcript">
            <Transcript berichten={berichten} zone={zone} />
          </Blok>

          {/* 5. Auditlog. */}
          <Blok titel="Auditlog">
            {auditlog.length === 0 ? (
              <Leeg>Nog geen gebeurtenissen vastgelegd.</Leeg>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {auditlog.map((regel) => (
                  <li key={regel.id} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
                      {datumTijdSeconden(regel.created_at, zone)}
                    </span>
                    <span>{AUDIT_LABEL[regel.action] ?? regel.action}</span>
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>
                      {regel.actor?.full_name ?? regel.actor?.email ?? regel.actor_type}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Blok>
        </main>

        {/*
         * Rechts: urgentie, volledigheid, feiten en documenten.
         *
         * Dit is `DossierSidebar` uit @intake/ui — hetzelfde paneel waarvoor die component
         * is gemaakt, en met opzet niet in het cliëntscherm: een cliënt zijn eigen
         * urgentie-inschatting tonen is een juridische uitspraak.
         */}
        <DossierPaneel dossier={dossier} documents={documents} intakeId={intake.id} />
      </div>
    </div>
  );
}

function Kerngegeven({ label, waarde }: { label: string; waarde: string }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </dt>
      <dd className="font-medium">{waarde}</dd>
    </div>
  );
}

function Blok({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded-lg border p-5"
      style={{ borderColor: 'var(--border)', background: 'var(--paper)' }}
    >
      <h2
        className="mb-3 text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--muted)' }}
      >
        {titel}
      </h2>
      {children}
    </section>
  );
}

function Leeg({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm" style={{ color: 'var(--muted)' }}>
      {children}
    </p>
  );
}

function Moment({
  tijd,
  tijdTekst,
  tekst,
  zone,
}: {
  tijd?: string;
  tijdTekst?: string;
  tekst: string;
  zone: Tijdzone;
}) {
  const wanneer = tijdTekst ?? (tijd ? datumTijd(tijd, zone) : '');
  return (
    <li className="flex flex-wrap items-baseline gap-x-3">
      <span className="font-mono text-xs" style={{ color: 'var(--muted)' }}>
        {wanneer}
      </span>
      <span>{tekst}</span>
    </li>
  );
}
