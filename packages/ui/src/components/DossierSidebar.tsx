'use client';

import { AlertTriangle, ChevronRight, Download, FileText } from 'lucide-react';
import { URGENCY_RANK, type UrgencyLevel } from '@intake/domain';
import { formatCompleteness, urgencyCaption, URGENCY_STYLES } from '../urgency';
import type { DocumentItem, DossierState } from '../types';

/**
 * Het dossierpaneel: urgentie, feiten, volledigheid.
 *
 * ## Alleen in het advocatendashboard
 *
 * In het prototype stond dit paneel naast het gespreksscherm van de cliënt. Dat kan niet.
 * Een cliënt zijn eigen urgentie-inschatting tonen ("HOOG — mogelijk vervaltermijn") is
 * een juridische uitspraak, en dit systeem doet die niet: het signaleert en een mens
 * beoordeelt. Hetzelfde geldt voor het volledigheidspercentage — dat is een maat voor de
 * bruikbaarheid van de intake voor het kantoor, geen rapportcijfer voor de cliënt.
 *
 * Deze component hoort dus achter de login van het kantoor. Er is bewust geen `variant`
 * of `hideUrgency`-vlag: een schakelaar zou betekenen dat één verkeerde prop het paneel
 * alsnog in het cliëntscherm zet.
 *
 * ## Urgentie wordt nooit als vaststelling getoond
 *
 * De tekst komt uit `urgencyCaption()` uit dit pakket, die de disclaimer altijd meedraagt.
 * Het prototype toonde `urgencyTitle — urgencyDescription` als vrije tekst zonder
 * voorbehoud; dat is precies wat §10 verbiedt.
 *
 * ## Feiten
 *
 * ## Op een telefoon geen eigen scrollgebied
 *
 * `overflow-y-auto` en de linkerrand gelden pas vanaf `lg`. In één kolom is een paneel dat
 * zelfstandig scrolt binnen een pagina die óók scrolt geen zijbalk meer maar een venster in
 * een venster — je raakt kwijt welke van de twee je beweegt. En een blok met
 * `height: fit-content` én een eigen scrollgebied is precies het soort constructie waar
 * browsers het onderling oneens over worden.
 *
 * ## Feiten
 *
 * Generiek over `CaseFact[]`, niet over een vaste lijst sleutels. Het prototype had
 * `primary_issue`, `sick_since` en vier andere hardgecodeerd; het arbeidsrecht-template
 * kent er zeventien conditionele categorieën, en een volgend rechtsgebied heeft andere.
 */

export interface DossierSidebarProps {
  readonly dossier: DossierState;
  readonly documents: readonly DocumentItem[];
  readonly onSelectDocument: (doc: DocumentItem) => void;
  readonly onExportDossier: () => void;
  readonly language?: 'nl' | 'en';
}

/** Het zwaarste signaal bepaalt de kleur van het blok. */
function hoogsteNiveau(niveaus: readonly UrgencyLevel[]): UrgencyLevel | null {
  return niveaus.reduce<UrgencyLevel | null>(
    (hoogste, n) => (hoogste === null || URGENCY_RANK[n] > URGENCY_RANK[hoogste] ? n : hoogste),
    null,
  );
}

function toonWaarde(fact: DossierState['facts'][number]): string {
  if (fact.status === 'unknown') return 'niet vastgesteld';
  if (typeof fact.value === 'boolean') return fact.value ? 'ja' : 'nee';
  if (fact.value === null || fact.value === undefined) return '—';
  return String(fact.value);
}

export function DossierSidebar({
  dossier,
  documents,
  onSelectDocument,
  onExportDossier,
  language = 'nl',
}: DossierSidebarProps) {
  const niveau = hoogsteNiveau(dossier.riskFlags.map((f) => f.level));
  const stijl = niveau ? URGENCY_STYLES[niveau] : null;
  const percentage = formatCompleteness(dossier.completeness);

  return (
    <aside
      className="flex w-full flex-col gap-6 border-t p-5 transition-colors sm:p-6 lg:w-[380px] lg:overflow-y-auto lg:border-l lg:border-t-0 xl:w-[420px]"
      style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
      aria-label="Dossier"
    >
      {/* Volledigheid */}
      <section className="space-y-2.5">
        <div className="flex items-center justify-between">
          <h2
            className="text-[11px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--app-text-muted)' }}
          >
            Volledigheid
          </h2>
          <span className="font-mono text-sm font-bold" style={{ color: 'var(--app-primary)' }}>
            {percentage}
          </span>
        </div>
        <div
          className="h-2.5 w-full overflow-hidden rounded-full border"
          style={{ backgroundColor: 'var(--app-surface)', borderColor: 'var(--app-border)' }}
          role="progressbar"
          aria-valuenow={
            dossier.completeness === null ? undefined : Math.round(dossier.completeness * 100)
          }
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Volledigheid van de intake"
        >
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${Math.round((dossier.completeness ?? 0) * 100)}%`,
              backgroundColor: 'var(--app-primary)',
            }}
          />
        </div>
      </section>

      {/* Urgentie */}
      <section className="space-y-2">
        <h2
          className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ color: 'var(--app-text-muted)' }}
        >
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          Urgentiesignalen
        </h2>

        {dossier.riskFlags.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--app-text-dim)' }}>
            Geen signalen.
          </p>
        ) : (
          <div
            className="space-y-2 rounded-xl border p-3.5 shadow-sm"
            style={{
              backgroundColor: stijl?.bg ?? 'var(--app-surface)',
              borderColor: stijl?.fg ?? 'var(--app-border)',
            }}
          >
            {/*
             * De disclaimer staat bovenaan en niet als voetnoot: hij hoort gelezen te
             * worden vóór de signalen, niet erna.
             */}
            {niveau && (
              <p
                className="text-[11px] font-semibold leading-snug"
                style={{ color: stijl?.fg ?? 'var(--app-text)' }}
              >
                {urgencyCaption(niveau, language)}
              </p>
            )}
            <ul className="space-y-1.5">
              {dossier.riskFlags.map((flag) => (
                <li
                  key={flag.ruleKey}
                  className="text-xs leading-relaxed sm:text-[13px]"
                  style={{ color: 'var(--app-text)' }}
                >
                  <span
                    className="mr-1.5 font-mono text-[10px] uppercase"
                    style={{ color: URGENCY_STYLES[flag.level].fg }}
                  >
                    {URGENCY_STYLES[flag.level].label[language]}
                  </span>
                  {flag.label}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {/* Vastgelegde feiten */}
      <section className="space-y-3">
        <h2
          className="text-[11px] font-bold uppercase tracking-wider"
          style={{ color: 'var(--app-text-muted)' }}
        >
          Vastgelegde feiten ({dossier.facts.length})
        </h2>

        {dossier.facts.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--app-text-dim)' }}>
            Nog niets vastgelegd.
          </p>
        ) : (
          <dl
            className="space-y-2.5 rounded-xl border p-3.5 font-mono text-xs shadow-sm"
            style={{ backgroundColor: 'var(--app-surface)', borderColor: 'var(--app-border)' }}
          >
            {dossier.facts.map((fact) => (
              <div key={fact.key} className="grid grid-cols-[130px_1fr] items-start gap-2 py-0.5">
                <dt className="truncate" style={{ color: 'var(--app-text-dim)' }} title={fact.key}>
                  {fact.key}
                </dt>
                <dd
                  className="font-semibold"
                  style={{
                    color: fact.status === 'unknown' ? 'var(--app-text-dim)' : 'var(--app-text)',
                    fontStyle: fact.status === 'unknown' ? 'italic' : undefined,
                  }}
                >
                  {toonWaarde(fact)}
                  {fact.status === 'contradicted' && (
                    <span className="ml-1.5" style={{ color: 'var(--urgency-high)' }}>
                      (tegenstrijdig)
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* Geweigerd */}
      {dossier.rejected.length > 0 && (
        <section className="space-y-1.5">
          <h2
            className="text-[11px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--app-text-muted)' }}
          >
            Geweigerd
          </h2>
          <ul
            className="space-y-1 rounded-lg border px-3 py-2 font-mono text-xs"
            style={{
              backgroundColor: 'var(--app-surface)',
              borderColor: 'var(--app-border)',
              color: 'var(--app-text-muted)',
            }}
          >
            {dossier.rejected.map((r) => (
              <li key={r.key}>
                {r.key}: {r.reason}
              </li>
            ))}
          </ul>
        </section>
      )}

      <span className="h-px" style={{ backgroundColor: 'var(--app-border)' }} />

      {/* Bewijsstukken */}
      <section className="space-y-3">
        <h2
          className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
          style={{ color: 'var(--app-text)' }}
        >
          <FileText className="h-3.5 w-3.5" style={{ color: 'var(--app-primary)' }} aria-hidden />
          Bewijsstukken ({documents.length})
        </h2>

        {documents.length === 0 ? (
          <p className="text-xs italic" style={{ color: 'var(--app-text-dim)' }}>
            Geen documenten gekoppeld.
          </p>
        ) : (
          <ul className="space-y-2">
            {documents.map((doc) => (
              <li key={doc.id}>
                <button
                  type="button"
                  onClick={() => onSelectDocument(doc)}
                  className="flex w-full items-center justify-between rounded-xl border p-3 text-left shadow-sm transition-all hover:opacity-95"
                  style={{
                    backgroundColor: 'var(--app-surface)',
                    borderColor: 'var(--app-border)',
                  }}
                >
                  <span className="min-w-0 pr-2">
                    <span
                      className="block truncate text-xs font-semibold"
                      style={{ color: 'var(--app-text)' }}
                    >
                      {doc.name}
                    </span>
                    <span
                      className="mt-0.5 block font-mono text-[10px]"
                      style={{ color: 'var(--app-text-dim)' }}
                    >
                      {doc.category} · {doc.size}
                    </span>
                  </span>
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: 'var(--app-primary)' }}
                    aria-hidden
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-auto space-y-2 border-t pt-4" style={{ borderColor: 'var(--app-border)' }}>
        <button
          type="button"
          onClick={onExportDossier}
          className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-bold shadow-md transition-all hover:opacity-90 active:scale-95"
          style={{ backgroundColor: 'var(--app-primary)', color: 'var(--app-primary-text)' }}
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Dossier en transcript downloaden
        </button>
      </div>
    </aside>
  );
}
