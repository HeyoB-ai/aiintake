import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * De twee clients die een agent-veilig proces mag hebben. Beide draaien op de
 * publishable key (`sb_publishable_...`), de sleutel die publiek mag zijn.
 *
 *   anon  — browser en publieke intakeroute. Ziet alleen wat RLS toestaat.
 *   agent — de worker. Ziet via RLS helemaal niets en werkt uitsluitend via de
 *           app.agent_* RPC's, die zich legitimeren met het sessietoken.
 *
 * Let op waar dat token NIET zit: niet in de Authorization-header. Dit project
 * gebruikt asymmetrische JWT signing keys, dus PostgREST verifieert een bearer token
 * tegen de JWKS van het project — een zelfgemaakt token levert daar 401 op. Het
 * sessietoken reist daarom als expliciete parameter bij elke RPC. Zie
 * docs/ADR-0007-agent-sessietoken.md.
 *
 * De client die RLS wél omzeilt woont in `@intake/db`, een pakket waar apps/agent
 * niet aan hangt.
 */

/**
 * De RPC's staan in `public`, het schema dat PostgREST standaard exposeert. Het
 * `app`-schema bevat alleen interne helpers en is bewust níét bereikbaar over HTTP;
 * zie docs/ADR-0008-rpc-in-public-schema.md.
 */
export type AppClient = SupabaseClient<any, 'public', any>;

export function createAnonClient(url: string, publishableKey: string): AppClient {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * De client van de worker. Identiek aan de anon-client: de sleutel geeft geen
 * rechten, het sessietoken doet dat, en dat gaat per aanroep mee.
 *
 * Deze functie bestaat naast createAnonClient om die uitleg ergens te kunnen laten
 * staan, en omdat de worker later mogelijk eigen fetch-opties nodig heeft (timeouts,
 * keep-alive) die de browserclient niet wil.
 */
export function createAgentClient(url: string, publishableKey: string): AppClient {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
