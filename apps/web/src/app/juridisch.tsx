import type { ReactNode } from 'react';

/**
 * De opmaak van de twee juridische teksten, en de conceptmarkering die er hoort te staan.
 *
 * ## Waarom de markering geen prop met een standaard is
 *
 * `concept = true` als default zou betekenen dat hij met één karakter uit te zetten is,
 * ergens in een pagina, zonder dat iemand het merkt. Hij zit daarom vast in dit component:
 * hem weghalen is een codewijziging die in een diff staat, en dat hoort ook — een tekst die
 * niet meer als concept geldt, is door iemand vastgesteld, en dat is een besluit.
 *
 * ## Waarom deze twee pagina's dezelfde vorm delen
 *
 * De cliënt geeft op één scherm voor allebei toestemming. Zien ze er verschillend uit, dan
 * lijkt de ene meer een document dan de andere, terwijl ze dezelfde status hebben.
 */
export function ConceptTekst({
  titel,
  versie,
  children,
}: {
  titel: string;
  versie: string;
  children: ReactNode;
}) {
  return (
    <main
      className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6"
      style={{ background: 'var(--app-bg)', color: 'var(--app-text)' }}
    >
      <div
        className="rounded-2xl border p-4"
        style={{
          backgroundColor: 'var(--urgency-critical-bg)',
          borderColor: 'var(--urgency-critical)',
          color: 'var(--urgency-critical)',
        }}
      >
        <p className="text-sm font-bold">Concept — niet vastgesteld</p>
        <p className="mt-1 text-sm leading-relaxed">
          Deze tekst beschrijft wat het systeem feitelijk vastlegt en aan wie het dat doorgeeft. Hij
          is niet juridisch getoetst en niet vastgesteld door het kantoor. Aan deze versie kunnen
          geen rechten worden ontleend.
        </p>
      </div>

      <h1 className="app-heading mt-6 text-2xl font-bold tracking-tight">{titel}</h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--app-text-dim)' }}>
        Versie {versie}
      </p>

      <div className="mt-6 space-y-4">{children}</div>
    </main>
  );
}

export function Kop({ children }: { children: ReactNode }) {
  return <h2 className="app-heading pt-2 text-base font-bold">{children}</h2>;
}

export function Alinea({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed">{children}</p>;
}

export function Lijst({ items }: { items: readonly string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
      {items.map((tekst) => (
        <li key={tekst}>{tekst}</li>
      ))}
    </ul>
  );
}
