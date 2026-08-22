import type { ReactNode } from 'react';
import { requireUser } from '@/lib/auth';
import { signOut } from '../login/actions';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const active = user.memberships[0] ?? null;

  return (
    <div className="min-h-screen">
      <header
        className="flex items-center justify-between border-b px-6 py-3"
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

        <div className="flex items-center gap-4 text-sm">
          {active ? (
            <span
              className="rounded px-2 py-0.5 text-xs font-medium"
              style={{ background: 'var(--accent-100)', color: 'var(--accent-700)' }}
            >
              {active.role}
            </span>
          ) : null}
          <span style={{ color: 'var(--muted)' }}>{user.email}</span>
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
