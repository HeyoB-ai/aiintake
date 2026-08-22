import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server-side Supabase-client die de sessie uit cookies leest.
 *
 * Belangrijk: gebruik altijd `getUser()` en nooit `getSession()` om te beslissen of
 * iemand ergens bij mag. `getSession()` leest de cookie zonder hem te verifiëren;
 * `getUser()` valideert het token bij de auth-server. Het verschil is precies het
 * verschil tussen wel en niet te vervalsen.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Aanroep vanuit een Server Component: de middleware ververst de sessie.
          }
        },
      },
    },
  );
}

/** Dezelfde client, maar gericht op het `app`-schema voor RPC-aanroepen. */
export async function createAppSchemaClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!,
    {
      db: { schema: 'app' } as never,
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => undefined,
      },
    },
  );
}
