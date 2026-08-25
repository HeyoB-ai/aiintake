'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { THEMES, type ThemeId } from '../themes';

/**
 * De themakiezer.
 *
 * Een kantoorinstelling, niet iets wat de cliënt tijdens een intake omzet. Hij hoort
 * daarom in het dashboard en in het voorbeeldscherm — niet in het gespreksscherm dat de
 * cliënt te zien krijgt.
 */

export interface ThemeSelectorProps {
  readonly currentTheme: ThemeId;
  readonly onSelectTheme: (id: ThemeId) => void;
}

export function ThemeSelector({ currentTheme, onSelectTheme }: ThemeSelectorProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Sluiten bij een klik ernaast en bij Escape. Zonder dit blijft het paneel open staan
  // zodra iemand er met het toetsenbord uit tabt.
  useEffect(() => {
    if (!open) return;
    const buiten = (e: MouseEvent): void => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const toets = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', buiten);
    document.addEventListener('keydown', toets);
    return () => {
      document.removeEventListener('mousedown', buiten);
      document.removeEventListener('keydown', toets);
    };
  }, [open]);

  const huidig = THEMES.find((t) => t.id === currentTheme);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium shadow-sm transition-colors hover:opacity-90"
        style={{
          backgroundColor: 'var(--app-card)',
          borderColor: 'var(--app-border)',
          color: 'var(--app-text)',
        }}
      >
        <Palette className="h-3.5 w-3.5" style={{ color: 'var(--app-primary)' }} aria-hidden />
        <span className="hidden sm:inline">{huidig?.name ?? 'Thema'}</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Thema kiezen"
          className="absolute right-0 z-40 mt-2 w-[320px] overflow-hidden rounded-xl border p-1.5 shadow-xl"
          style={{
            backgroundColor: 'var(--app-card)',
            borderColor: 'var(--app-border)',
            boxShadow: 'var(--app-shadow-lg)',
          }}
        >
          {THEMES.map((thema) => {
            const actief = thema.id === currentTheme;
            return (
              <button
                key={thema.id}
                type="button"
                role="option"
                aria-selected={actief}
                onClick={() => {
                  onSelectTheme(thema.id);
                  setOpen(false);
                }}
                className="flex w-full items-start gap-3 rounded-lg p-2.5 text-left transition-colors"
                style={{ backgroundColor: actief ? 'var(--app-accent-bg)' : 'transparent' }}
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex h-9 w-9 shrink-0 overflow-hidden rounded-md border"
                  style={{ borderColor: 'var(--app-border)', backgroundColor: thema.preview.bg }}
                >
                  <span className="h-full w-1/2" style={{ backgroundColor: thema.preview.card }} />
                  <span
                    className="h-full w-1/2"
                    style={{ backgroundColor: thema.preview.primary }}
                  />
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span
                      className="truncate text-sm font-semibold"
                      style={{ color: 'var(--app-text)' }}
                    >
                      {thema.name}
                    </span>
                    {actief && (
                      <Check
                        className="h-3.5 w-3.5 shrink-0"
                        style={{ color: 'var(--app-primary)' }}
                        aria-hidden
                      />
                    )}
                  </span>
                  <span
                    className="mt-0.5 block text-[11px] leading-snug"
                    style={{ color: 'var(--app-text-muted)' }}
                  >
                    {thema.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
