'use client';

import { useActionState } from 'react';
import { signIn, type LoginState } from './actions';

const initial: LoginState = { error: null };

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(signIn, initial);

  return (
    <form action={action} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">E-mailadres</span>
        <input
          type="email"
          name="email"
          required
          autoComplete="username"
          className="w-full rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--paper)' }}
        />
      </label>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">Wachtwoord</span>
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--paper)' }}
        />
      </label>

      {state.error ? (
        <p role="alert" className="text-sm" style={{ color: 'var(--urgency-critical)' }}>
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
        style={{ background: 'var(--accent-600)' }}
      >
        {pending ? 'Bezig…' : 'Inloggen'}
      </button>
    </form>
  );
}
