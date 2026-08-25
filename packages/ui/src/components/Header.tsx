'use client';

import { FileText, RotateCcw, Shield, Video } from 'lucide-react';
import type { FaseStand, SessieFasen } from '../types';
import { ThemeSelector } from './ThemeSelector';
import type { ThemeId } from '../themes';

/**
 * De kop van het gespreksscherm.
 *
 * ## Wat er veranderd is
 *
 * In het prototype stonden "verbonden" en "eerste frame" hardgecodeerd op groen. Het scherm
 * meldde dus altijd dat de verbinding stond, ook als er niets was — precies de klasse fout
 * waar eerder een avond in ging zitten. Hier komen de drie badges uit `fasen`.
 *
 * De kantoornaam komt uit de organisatieconfiguratie en staat niet in de code. Een
 * hardgecodeerde naam in een multi-tenant product is een fout die pas bij de tweede klant
 * zichtbaar wordt.
 *
 * Weggelaten: de exportknop. Het dossier exporteren is een handeling van het kantoor, niet
 * van de cliënt, en hij hoort dus in het dashboard.
 */

export interface HeaderProps {
  readonly orgName: string;
  readonly fasen: SessieFasen;
  readonly documentCount: number;
  readonly activeTab: 'intake' | 'documenten';
  readonly onSelectTab: (tab: 'intake' | 'documenten') => void;
  readonly onResetSession: () => void;
  /** Themakiezer tonen. Uit in het scherm dat een cliënt te zien krijgt. */
  readonly showThemeSelector?: boolean;
  readonly currentTheme?: ThemeId;
  readonly onSelectTheme?: (id: ThemeId) => void;
}

const KLEUR: Record<FaseStand, { bg: string; fg: string; rand: string }> = {
  wachten: {
    bg: 'var(--app-surface)',
    fg: 'var(--app-text-dim)',
    rand: 'var(--app-border)',
  },
  bezig: {
    bg: 'var(--app-accent-bg)',
    fg: 'var(--app-accent-text)',
    rand: 'var(--app-accent-border)',
  },
  klaar: {
    bg: 'var(--app-badge-green-bg)',
    fg: 'var(--app-badge-green-text)',
    rand: 'var(--app-badge-green-border)',
  },
  fout: {
    bg: 'var(--urgency-critical-bg)',
    fg: 'var(--urgency-critical)',
    rand: 'var(--urgency-critical)',
  },
};

function FaseBadge({ label, stand }: { label: string; stand: FaseStand }) {
  const kleur = KLEUR[stand];
  return (
    <span
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors sm:text-xs"
      style={{ backgroundColor: kleur.bg, color: kleur.fg, borderColor: kleur.rand }}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${stand === 'bezig' ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: kleur.fg }}
        aria-hidden
      />
      {label}
    </span>
  );
}

export function Header({
  orgName,
  fasen,
  documentCount,
  activeTab,
  onSelectTab,
  onResetSession,
  showThemeSelector = false,
  currentTheme,
  onSelectTheme,
}: HeaderProps) {
  return (
    <header
      className="sticky top-0 z-30 border-b px-4 py-3 backdrop-blur-md transition-colors sm:px-6"
      style={{
        backgroundColor: 'var(--app-header-bg)',
        borderColor: 'var(--app-border)',
        boxShadow: 'var(--app-shadow)',
      }}
    >
      <div className="mx-auto flex max-w-[1700px] flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1
              className="app-heading text-xl font-bold tracking-tight sm:text-2xl"
              style={{ color: 'var(--app-text)' }}
            >
              Intakegesprek
            </h1>
            <span
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold shadow-sm"
              style={{
                backgroundColor: 'var(--app-accent-bg)',
                color: 'var(--app-accent-text)',
                borderColor: 'var(--app-accent-border)',
              }}
            >
              <Shield className="h-3 w-3" aria-hidden />
              {orgName}
            </span>
          </div>
          <p className="text-xs sm:text-sm" style={{ color: 'var(--app-text-muted)' }}>
            U spreekt met een AI-assistent en niet met een advocaat. Onderbreken mag.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <FaseBadge label="sessie" stand={fasen.sessie} />
            <FaseBadge label="verbonden" stand={fasen.verbonden} />
            <FaseBadge label="eerste frame" stand={fasen.eersteFrame} />
          </div>

          {showThemeSelector && currentTheme && onSelectTheme && (
            <>
              <span
                className="hidden h-4 w-px sm:block"
                style={{ backgroundColor: 'var(--app-border)' }}
              />
              <ThemeSelector currentTheme={currentTheme} onSelectTheme={onSelectTheme} />
            </>
          )}

          <span
            className="hidden h-4 w-px sm:block"
            style={{ backgroundColor: 'var(--app-border)' }}
          />

          <div
            className="flex items-center rounded-lg border p-1 text-xs"
            style={{ backgroundColor: 'var(--app-surface)', borderColor: 'var(--app-border)' }}
            role="tablist"
            aria-label="Weergave"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'intake'}
              onClick={() => onSelectTab('intake')}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-all"
              style={{
                backgroundColor: activeTab === 'intake' ? 'var(--app-primary)' : 'transparent',
                color: activeTab === 'intake' ? 'var(--app-primary-text)' : 'var(--app-text-muted)',
              }}
            >
              <Video className="h-3.5 w-3.5" aria-hidden />
              <span className="hidden sm:inline">Gesprek</span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'documenten'}
              onClick={() => onSelectTab('documenten')}
              className="relative flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-all"
              style={{
                backgroundColor: activeTab === 'documenten' ? 'var(--app-primary)' : 'transparent',
                color:
                  activeTab === 'documenten' ? 'var(--app-primary-text)' : 'var(--app-text-muted)',
              }}
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              <span>Documenten</span>
              {documentCount > 0 && (
                <span
                  className="rounded-full px-1.5 font-mono text-[10px] font-bold"
                  style={{
                    backgroundColor:
                      activeTab === 'documenten'
                        ? 'rgb(255 255 255 / 20%)'
                        : 'var(--app-accent-bg)',
                    color:
                      activeTab === 'documenten'
                        ? 'var(--app-primary-text)'
                        : 'var(--app-accent-text)',
                  }}
                >
                  {documentCount}
                </span>
              )}
            </button>
          </div>

          <button
            type="button"
            onClick={onResetSession}
            className="rounded-lg border p-1.5 text-xs transition-colors hover:opacity-90"
            style={{
              backgroundColor: 'var(--app-card)',
              borderColor: 'var(--app-border)',
              color: 'var(--app-text-muted)',
            }}
            title="Gesprek opnieuw beginnen"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Gesprek opnieuw beginnen</span>
          </button>
        </div>
      </div>
    </header>
  );
}
