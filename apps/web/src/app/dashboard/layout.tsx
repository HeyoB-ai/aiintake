import type { ReactNode } from 'react';
import { requireUser } from '@/lib/auth';
import { signOut } from '../login/actions';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const active = user.memberships[0] ?? null;

  return (
    <div className="min-h-screen">
      <header
        // Mag afbreken op een telefoon. Zonder `flex-wrap` bleef deze rij op volle
        // breedte staan en werd de pagina 425px breed in een venster van 390 — de hele
        // site scrolde dan horizontaal, ook de pagina's die zelf netjes passen.
        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-3 sm:px-6"
        style={{ borderColor: 'var(--border)', background: 'var(--paper)' }}
      >
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">Intake</span>
          {active ? (
            <span className="text-sm" style={{ color: 'var(--muted)' }}>
              {active.organizationName}
            </span>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {active ? (
            <span
              className="rounded px-2 py-0.5 text-xs font-medium"
              style={{ background: 'var(--accent-100)', color: 'var(--accent-700)' }}
            >
              {active.role}
            </span>
          ) : null}
          {/* Een lang e-mailadres mag inkorten in plaats van de rij op te rekken. */}
          <span className="max-w-[46vw] truncate sm:max-w-none" style={{ color: 'var(--muted)' }}>
            {user.email}
          </span>
          <form action={signOut}>
            <button type="submit" className="underline underline-offset-2">
              Uitloggen
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
