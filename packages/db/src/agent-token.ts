import { SignJWT, jwtVerify } from 'jose';

/**
 * Het kortlevende sessietoken van de agent-worker.
 *
 * Achtergrond: een langlevend proces met een service-role key kan bij elke tenant.
 * Dat is het grootste RLS-omzeilingsrisico in dit project (§4). De mitigatie is dat
 * het agentproces die key niet krijgt. In plaats daarvan mint de web-app bij
 * sessiestart dit token, gebonden aan één intake, met een TTL van de sessieduur plus
 * vijf minuten. Alles wat de agent daarna schrijft, gaat via de `app.agent_*` RPC's
 * die `intake_id` uit dit token verifiëren.
 *
 * Het token draagt `role: 'authenticated'` zodat PostgREST het accepteert, maar levert
 * géén organisatielidmaatschap op — elke RLS-policy wijst het dus af. De RPC's zijn
 * het enige oppervlak dat het kan bereiken.
 */

export interface AgentTokenClaims {
  /** De enige intake die dit token mag aanraken. */
  readonly intakeId: string;
  readonly organizationId: string;
  readonly sessionId: string;
}

export interface MintOptions extends AgentTokenClaims {
  /** Supabase JWT secret. Alleen serverside beschikbaar. */
  readonly jwtSecret: string;
  /** Maximale sessieduur in minuten, uit organizations.session_limits. */
  readonly maxSessionMinutes: number;
}

const GRACE_MINUTES = 5;

export async function mintAgentToken(
  opts: MintOptions,
): Promise<{ token: string; expiresAt: Date }> {
  if (!opts.jwtSecret) throw new Error('jwtSecret ontbreekt');

  const ttlSeconds = (opts.maxSessionMinutes + GRACE_MINUTES) * 60;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const key = new TextEncoder().encode(opts.jwtSecret);

  const token = await new SignJWT({
    // PostgREST leest `role` om de databaserol te kiezen.
    role: 'authenticated',
    // Onze eigen discriminator; app.is_agent_token() controleert hierop.
    token_type: 'intake_agent',
    intake_id: opts.intakeId,
    organization_id: opts.organizationId,
    session_id: opts.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    // `sub` is de sessie, niet een gebruiker. Er hoort geen mens bij dit token.
    .setSubject(opts.sessionId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key);

  return { token, expiresAt };
}

export async function verifyAgentToken(
  token: string,
  jwtSecret: string,
): Promise<AgentTokenClaims> {
  const key = new TextEncoder().encode(jwtSecret);
  const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });

  if (payload['token_type'] !== 'intake_agent') {
    throw new Error('geen agent-token');
  }
  const intakeId = payload['intake_id'];
  const organizationId = payload['organization_id'];
  const sessionId = payload['session_id'];

  if (
    typeof intakeId !== 'string' ||
    typeof organizationId !== 'string' ||
    typeof sessionId !== 'string'
  ) {
    throw new Error('agent-token mist verplichte claims');
  }
  return { intakeId, organizationId, sessionId };
}
