'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, FileText, X, ZoomIn, ZoomOut } from 'lucide-react';
import { URGENCY_STYLES } from '../urgency';
import type { DocumentItem } from '../types';

/**
 * Eén document van dichtbij bekijken.
 *
 * ## Wat er is weggehaald
 *
 * Het prototype zette in elk document "AI Verified", "Geverifieerd & Toegevoegd aan
 * bewijslast", een vast dossiernummer (#2026-INTAKE-882) en een vast zaaktype. Dat waren
 * geen gegevens maar decoratie: ze stonden er ongeacht welk bestand je opende. Een scherm
 * dat "geverifieerd" zegt over iets wat niemand heeft geverifieerd, is een bewering die
 * het kantoor niet kan waarmaken.
 *
 * Wat er wél staat, komt uit het document zelf, en elk geëxtraheerd feit toont zijn
 * herkomst. Dezelfde regel als `TraceableCaseFactSchema`: geen bewering zonder bron.
 *
 * ## Toegankelijkheid
 *
 * Escape sluit, de focus gaat bij openen naar de dialoog en keert bij sluiten terug naar
 * het element dat hem opende. Een modaal zonder dat is met het toetsenbord een val.
 */

export interface DocumentViewerModalProps {
  readonly document: DocumentItem | null;
  readonly onClose: () => void;
}

type Tab = 'inhoud' | 'feiten';

export function DocumentViewerModal({ document: doc, onClose }: DocumentViewerModalProps) {
  const [tab, setTab] = useState<Tab>('inhoud');
  const [gekopieerd, setGekopieerd] = useState(false);
  const [zoom, setZoom] = useState(100);
  const dialoogRef = useRef<HTMLDivElement>(null);
  const vorigeFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!doc) return;
    vorigeFocus.current = window.document.activeElement;
    dialoogRef.current?.focus();
    const toets = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.document.addEventListener('keydown', toets);
    return () => {
      window.document.removeEventListener('keydown', toets);
      (vorigeFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [doc, onClose]);

  if (!doc) return null;

  const kopieer = (): void => {
    if (!doc.textContent) return;
    void navigator.clipboard.writeText(doc.textContent).then(() => {
      setGekopieerd(true);
      setTimeout(() => setGekopieerd(false), 2000);
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialoogRef}
        role="dialog"
        aria-modal="true"
        aria-label={doc.name}
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
      >
        <header
          className="flex items-center justify-between gap-3 border-b p-4 sm:p-5"
          style={{ backgroundColor: 'var(--app-surface)', borderColor: 'var(--app-border)' }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="shrink-0 rounded-xl border p-2.5"
              style={{
                backgroundColor: 'var(--app-accent-bg)',
                color: 'var(--app-primary)',
                borderColor: 'var(--app-accent-border)',
              }}
            >
              <FileText className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold" style={{ color: 'var(--app-text)' }}>
                {doc.name}
              </h2>
              <p
                className="mt-0.5 flex flex-wrap items-center gap-2 text-xs"
                style={{ color: 'var(--app-text-dim)' }}
              >
                <span
                  className="rounded-full border px-2.5 py-0.5 font-medium"
                  style={{
                    backgroundColor: 'var(--app-card)',
                    borderColor: 'var(--app-border)',
                    color: 'var(--app-text-muted)',
                  }}
                >
                  {doc.category}
                </span>
                <span className="font-mono">{doc.size}</span>
                <span>{doc.uploadedAt}</span>
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {doc.textContent && (
              <button
                type="button"
                onClick={kopieer}
                className="flex items-center gap-1.5 rounded-xl border p-2 text-xs font-medium transition-all hover:opacity-90"
                style={{
                  backgroundColor: 'var(--app-card)',
                  borderColor: 'var(--app-border)',
                  color: 'var(--app-text)',
                }}
              >
                {gekopieerd ? (
                  <Check
                    className="h-4 w-4"
                    style={{ color: 'var(--app-badge-green-text)' }}
                    aria-hidden
                  />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                <span className="hidden sm:inline">
                  {gekopieerd ? 'Gekopieerd' : 'Kopieer tekst'}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border p-2 transition-colors hover:opacity-80"
              style={{
                backgroundColor: 'var(--app-card)',
                borderColor: 'var(--app-border)',
                color: 'var(--app-text-muted)',
              }}
            >
              <X className="h-4 w-4" aria-hidden />
              <span className="sr-only">Sluiten</span>
            </button>
          </div>
        </header>

        <div
          className="flex items-center justify-between border-b px-4 sm:px-6"
          style={{
            backgroundColor: 'var(--app-surface-subtle)',
            borderColor: 'var(--app-border)',
          }}
        >
          <div className="flex gap-2" role="tablist">
            {(
              [
                ['inhoud', 'Documentweergave'],
                ['feiten', `Geëxtraheerde feiten (${doc.extractedFacts.length})`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className="border-b-2 px-3.5 py-2.5 text-xs font-semibold transition-all"
                style={{
                  borderColor: tab === id ? 'var(--app-primary)' : 'transparent',
                  color: tab === id ? 'var(--app-primary)' : 'var(--app-text-muted)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'inhoud' && (
            <div
              className="flex items-center gap-1 py-1"
              style={{ color: 'var(--app-text-muted)' }}
            >
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(75, z - 15))}
                className="rounded p-1"
                title="Uitzoomen"
              >
                <ZoomOut className="h-3.5 w-3.5" aria-hidden />
              </button>
              <span
                className="w-10 text-center font-mono text-[10px]"
                style={{ color: 'var(--app-text-dim)' }}
              >
                {zoom}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(150, z + 15))}
                className="rounded p-1"
                title="Inzoomen"
              >
                <ZoomIn className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6" style={{ backgroundColor: 'var(--app-bg)' }}>
          {tab === 'inhoud' && (
            <div
              className="mx-auto max-w-2xl"
              style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top center' }}
            >
              <div
                className="space-y-6 rounded-2xl border p-8 shadow-md"
                style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
              >
                {doc.previewUrl && doc.type === 'image' ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={doc.previewUrl}
                    alt={`Voorbeeld van ${doc.name}`}
                    className="w-full rounded-xl border"
                    style={{ borderColor: 'var(--app-border)' }}
                  />
                ) : doc.textContent ? (
                  <pre
                    className="whitespace-pre-wrap rounded-xl border p-5 font-mono text-xs leading-relaxed sm:text-sm"
                    style={{
                      backgroundColor: 'var(--app-surface)',
                      borderColor: 'var(--app-border)',
                      color: 'var(--app-text)',
                    }}
                  >
                    {doc.textContent}
                  </pre>
                ) : (
                  <p className="text-sm" style={{ color: 'var(--app-text-dim)' }}>
                    Er is nog geen tekstweergave van dit document.
                  </p>
                )}
              </div>
            </div>
          )}

          {tab === 'feiten' && (
            <div className="mx-auto max-w-2xl space-y-4">
              {doc.summary && (
                <div
                  className="rounded-2xl border p-5 shadow-sm"
                  style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
                >
                  <h3 className="mb-2 text-sm font-bold" style={{ color: 'var(--app-text)' }}>
                    Samenvatting
                  </h3>
                  <p className="text-sm leading-relaxed" style={{ color: 'var(--app-text-muted)' }}>
                    {doc.summary}
                  </p>
                </div>
              )}

              {doc.extractedFacts.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--app-text-dim)' }}>
                  Er zijn geen feiten uit dit document overgenomen.
                </p>
              ) : (
                <ul className="space-y-2.5">
                  {doc.extractedFacts.map((fact) => (
                    <li
                      key={`${fact.label}-${fact.sourceRef}`}
                      className="flex items-center justify-between gap-3 rounded-xl border p-3.5 shadow-sm"
                      style={{
                        backgroundColor: 'var(--app-card)',
                        borderColor: 'var(--app-border)',
                      }}
                    >
                      <div className="min-w-0">
                        <span className="block text-xs" style={{ color: 'var(--app-text-dim)' }}>
                          {fact.label}
                        </span>
                        <span
                          className="mt-0.5 block font-mono text-sm font-semibold"
                          style={{ color: 'var(--app-text)' }}
                        >
                          {fact.value}
                        </span>
                        {/* Herkomst, altijd zichtbaar: geen bewering zonder bron. */}
                        <span
                          className="mt-1 block font-mono text-[10px]"
                          style={{ color: 'var(--app-text-dim)' }}
                        >
                          bron: {fact.sourceRef}
                        </span>
                      </div>
                      {fact.level && (
                        <span
                          className="shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                          style={{
                            backgroundColor: URGENCY_STYLES[fact.level].bg,
                            color: URGENCY_STYLES[fact.level].fg,
                            borderColor: URGENCY_STYLES[fact.level].fg,
                          }}
                        >
                          {URGENCY_STYLES[fact.level].label.nl}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <footer
          className="flex items-center justify-between border-t p-4"
          style={{ backgroundColor: 'var(--app-surface)', borderColor: 'var(--app-border)' }}
        >
          <span className="font-mono text-xs" style={{ color: 'var(--app-text-dim)' }}>
            {doc.id}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border px-4 py-2 text-sm font-semibold shadow-sm transition-all hover:opacity-90"
            style={{
              backgroundColor: 'var(--app-card)',
              borderColor: 'var(--app-border)',
              color: 'var(--app-text)',
            }}
          >
            Sluiten
          </button>
        </footer>
      </div>
    </div>
  );
}
