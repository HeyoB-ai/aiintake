import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * De twee clients die een agent-veilig proces mag hebben:
 *
 *   anon  — browser en publieke intakeroute. Ziet alleen wat RLS toestaat.
 *   agent — de worker, met het kortlevende intake-token. Ziet via RLS helemaal niets
 *           en werkt uitsluitend via de app.agent_* RPC's.
 *
 * De service-role client woont bewust in `@intake/db`, een pakket waar apps/agent
 * niet aan hangt.
 */

/** RPC's leven in het `app`-schema; die schemakeuze zit in de client, niet in elke call. */
const APP_SCHEMA = 'app' as const;

export type AppClient = SupabaseClient<any, 'app', any>;

export function createAnonClient(url: string, anonKey: string): AppClient {
  return createClient(url, anonKey, {
    db: { schema: APP_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * De agent-worker. Let op de anon key: het token doet het werk, niet de key.
 * Een service-role key komt hier bewust niet voor.
 */
export function createAgentClient(url: string, anonKey: string, agentToken: string): AppClient {
  return createClient(url, anonKey, {
    db: { schema: APP_SCHEMA },
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${agentToken}` } },
  });
}
