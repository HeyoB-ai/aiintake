import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
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

  // Expliciet getypeerd om dezelfde reden als in middleware.ts: niet leunen op contextuele
  // inferentie door de signatuur van createServerClient heen.
  const cookieMethods: CookieMethodsServer = {
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
  };

  return createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']!,
    { cookies: cookieMethods },
  );
}

// Hier stond createAppSchemaClient(), een tweede client die op het `app`-schema was
// gericht. Overbodig sinds de client-gerichte RPC's in `public` staan: createClient()
// hierboven bereikt ze gewoon. Zie docs/ADR-0008-rpc-in-public-schema.md.
