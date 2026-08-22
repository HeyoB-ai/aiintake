import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Omzeilt RLS volledig.
 *
 * Alleen aanroepen vanuit Next.js server-code, en alleen waar geen enkele andere weg
 * bestaat: documentuploads na magic-byte-validatie, de retentie-cleanup, en het
 * aanmaken van organisaties. Nooit voor iets wat de ingelogde gebruiker zelf mag doen —
 * dan hoort het via een policy te lopen, niet hier langs.
 *
 * Dit staat bewust in `@intake/db` en niet in `@intake/db-core`: de agent-worker hangt
 * aan db-core en kan deze functie daardoor niet importeren.
 */
export function createServiceRoleClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
