'use client';

import { Shield, Sparkles } from 'lucide-react';

/**
 * Scherm 1 — welkom.
 *
 * ## De AI-mededeling staat vóór de knop, niet eronder
 *
 * De spec eist dat de disclosure prominent is. Prominent betekent hier: in het blikveld
 * voordat iemand op START INTAKE drukt, in gewone woorden, en niet als grijze voetnoot bij
 * de privacyverklaring. Iemand die pas ná het starten leest dat hij met een machine praat,
 * heeft die keuze niet gemaakt.
 *
 * Twee mededelingen, niet één: *dat het een AI is* en *dat het geen advocaat is en geen
 * advies geeft*. De tweede vervangt de eerste niet — "ik ben geen advocaat" zegt wat het
 * niet is, niet wát het is. Dezelfde regel als in de gesproken openingsbeurt.
 */

export interface WelkomProps {
  readonly organisatieNaam: string;
  readonly logoUrl: string | null;
  readonly onStart: () => void;
}

export function Welkom({ organisatieNaam, logoUrl, onStart }: WelkomProps) {
  return (
    <section className="flex flex-1 flex-col justify-center gap-6 py-6">
      <header className="flex flex-col items-center gap-3 text-center">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={organisatieNaam} className="h-12 w-auto" />
        ) : (
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl border"
            style={{
              backgroundColor: 'var(--app-accent-bg)',
              borderColor: 'var(--app-accent-border)',
              color: 'var(--app-accent-text)',
            }}
          >
            <Shield className="h-6 w-6" aria-hidden />
          </span>
        )}
        <h1 className="app-heading text-2xl font-bold tracking-tight">{organisatieNaam}</h1>
      </header>

      <p className="text-center text-base leading-relaxed">
        Welkom. Voordat u een advocaat spreekt, stellen we een aantal vragen over uw situatie. Dat
        duurt ongeveer tien minuten en u kunt op elk moment stoppen.
      </p>

      {/* De disclosure. Kader, icoon en eigen ruimte: dit is geen kleine lettertjes. */}
      <div
        className="rounded-2xl border p-4 sm:p-5"
        style={{
          backgroundColor: 'var(--app-accent-bg)',
          borderColor: 'var(--app-accent-border)',
        }}
      >
        <h2
          className="flex items-center gap-2 text-sm font-bold"
          style={{ color: 'var(--app-accent-text)' }}
        >
          <Sparkles className="h-4 w-4" aria-hidden />U spreekt met een AI-assistent
        </h2>
        <p className="mt-2 text-sm leading-relaxed">
          Dit gesprek voert u met een AI-assistent, niet met een advocaat. De assistent geeft geen
          juridisch advies en doet geen uitspraak over uw zaak. Zij legt vast wat u vertelt, zodat
          een advocaat van {organisatieNaam} het daarna kan beoordelen.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
        <button
          type="button"
          onClick={onStart}
          className="rounded-xl px-5 py-3 text-base font-semibold shadow-sm transition-all active:scale-[0.98]"
          style={{ backgroundColor: 'var(--app-primary)', color: 'var(--app-primary-text)' }}
        >
          Start intake
        </button>
        <a
          href="/privacy"
          className="rounded-xl border px-5 py-3 text-center text-base font-medium transition-colors"
          style={{
            backgroundColor: 'var(--app-card)',
            borderColor: 'var(--app-border)',
            color: 'var(--app-text)',
          }}
        >
          Privacy
        </a>
      </div>
    </section>
  );
}
