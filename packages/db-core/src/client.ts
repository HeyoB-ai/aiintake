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

/** De header waarin het workergeheim reist. Zie RISICOS.md risico 31. */
export const WORKER_SECRET_HEADER = 'x-agent-worker-secret';

/**
 * De client van de worker.
 *
 * ## Twee factoren, en dit is de tweede
 *
 * De sleutel geeft geen rechten en het sessietoken bewijst alleen wélke intake. Dat was
 * niet genoeg: de browser van de cliënt heeft allebei — de publishable key staat in de
 * bundel en het token komt mee in de WebSocket-URL. Daarmee kon een cliënt een
 * assistent-beurt in zijn eigen dossier schrijven die van een echte niet te
 * onderscheiden is (RISICOS.md risico 31).
 *
 * Het workergeheim is wat de browser niet heeft. Het reist als header en niet als
 * parameter, want dan verandert er één functie in de database — `app.assert_agent_scope`,
 * die elke agent-RPC toch al als eerste regel aanroept — in plaats van tien
 * handtekeningen met alle aanroepers eromheen. Veiliger is een parameter niet: allebei
 * reizen ze over TLS in hetzelfde verzoek.
 *
 * ## Waarom het optioneel is in het type en niet in productie
 *
 * Zonder geheim werkt deze client precies als vóór risico 31, en daar zijn de tests en
 * de diagnoses op gebouwd. De afdwinging staat in de database en niet hier: laat je hem
 * weg, dan weigert Postgres elke schrijfactie. Een client die er zelf over klaagt zou
 * suggereren dat híj de bewaker is.
 */
export function createAgentClient(
  url: string,
  publishableKey: string,
  workerSecret?: string,
): AppClient {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(workerSecret
      ? { global: { headers: { [WORKER_SECRET_HEADER]: workerSecret } } }
      : {}),
  });
}
