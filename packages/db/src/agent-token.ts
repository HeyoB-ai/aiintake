/**
 * Het sessietoken van de agent-worker.
 *
 * Achtergrond: een langlevend proces met een sleutel die RLS omzeilt, kan bij elke
 * tenant. Dat is het grootste RLS-omzeilingsrisico in dit project (§4). De mitigatie
 * is dat het agentproces zo'n sleutel niet krijgt. In plaats daarvan geeft de web-app
 * bij sessiestart dit token uit, gebonden aan één intake, met een TTL van de
 * sessieduur plus marge.
 *
 * Het is een ondoorzichtig token, geen JWT. Twee redenen:
 *
 *  1. Dit project gebruikt de nieuwe API-keys en dus asymmetrische JWT signing keys.
 *     PostgREST verifieert een bearer token tegen de JWKS van het project, en die
 *     private key zit in Supabase Auth. Wij kunnen geen JWT maken dat als
 *     Authorization-header wordt geaccepteerd — dat levert 401 op vóórdat er een RPC
 *     draait. Het token moet dus hoe dan ook als RPC-parameter reizen, en dan verliest
 *     een zelfgedragen handtekening zijn hele voordeel.
 *  2. Een opaque token is intrekbaar. `app.agent_end_session()` zet `revoked_at`
 *     zodra de sessie eindigt, en dat is meestal ruim vóór de TTL. Een JWT blijft
 *     geldig tot zijn `exp`, wat je ook doet.
 *
 * Zie docs/ADR-0007-agent-sessietoken.md.
 */

/**
 * 32 bytes uit de CSPRNG. Base64url levert 43 tekens op, zonder padding en zonder
 * tekens die in een URL of header ontsnapt moeten worden.
 *
 * 256 bit is ruim: raden is uitgesloten, en daarom is een timing-veilige vergelijking
 * bij de lookup ook niet nodig — bij een willekeurig token van deze lengte valt er
 * niets uit responstijden af te leiden.
 */
const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Het ruwe token. Bestaat alleen in het geheugen; gaat naar de worker, nergens anders. */
  readonly token: string;
  /** Wat de database te zien krijgt. Hex-gecodeerde SHA-256. */
  readonly tokenHash: string;
}

export async function createSessionToken(): Promise<IssuedToken> {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  return { token, tokenHash: await hashSessionToken(token) };
}

/**
 * Moet exact overeenkomen met `app.hash_session_token()` in migratie 0600.
 * Wijkt één van de twee af, dan valideert geen enkel token meer — de isolatietest
 * `mag naar zijn eigen intake schrijven` vangt dat.
 */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
