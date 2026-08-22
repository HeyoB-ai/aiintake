import { LoginForm } from './login-form';

export const metadata = { title: 'Inloggen — Intake' };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-10">
          <h1 className="text-2xl font-semibold tracking-tight">Intake</h1>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            Toegang voor medewerkers van aangesloten kantoren.
          </p>
        </div>

        <LoginForm next={next} />

        <p className="mt-8 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
          Accounts worden aangemaakt door de beheerder van uw kantoor. Er is geen zelfregistratie.
        </p>
      </div>
    </main>
  );
}
