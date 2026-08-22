import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createSessionToken } from '../agent-token';

/**
 * Testharnas voor de tenant-isolatietests.
 *
 * Deze tests draaien tegen een échte Supabase-database, niet tegen een mock. Dat is
 * geen keuze maar een noodzaak: RLS-policies zijn Postgres-gedrag, en een mock die ze
 * nabootst test alleen de mock. Zonder database worden ze overgeslagen met een
 * expliciete melding — nooit stilzwijgend groen.
 *
 * Gebruikerstokens worden hier via een echte inlogflow opgehaald en niet zelf
 * ondertekend. Dat kán ook niet meer: met asymmetrische signing keys zit de private
 * key in Supabase Auth. Dat is meteen de reden dat het agent-token geen JWT meer is;
 * zie docs/ADR-0007-agent-sessietoken.md.
 *
 * Benodigde env (zie .env.example):
 *   SUPABASE_TEST_URL
 *   SUPABASE_TEST_SECRET_KEY
 *   SUPABASE_TEST_PUBLISHABLE_KEY
 */

export interface TestEnv {
  url: string;
  secretKey: string;
  publishableKey: string;
}

const REQUIRED_TEST_VARS = [
  'SUPABASE_TEST_URL',
  'SUPABASE_TEST_PUBLISHABLE_KEY',
  'SUPABASE_TEST_SECRET_KEY',
] as const;

export function readTestEnv(): TestEnv | null {
  const url = process.env['SUPABASE_TEST_URL'];
  const secretKey = process.env['SUPABASE_TEST_SECRET_KEY'];
  const publishableKey = process.env['SUPABASE_TEST_PUBLISHABLE_KEY'];
  if (!url || !secretKey || !publishableKey) return null;
  return { url, secretKey, publishableKey };
}

/**
 * Legt uit waaróm de suite overslaat.
 *
 * Onderscheidt de twee gevallen die er in de praktijk toe doen: er is geen
 * `.env`-bestand gevonden (dan ligt het aan het inlezen), of het bestand is gelezen
 * maar mist een variabele (dan ligt het aan de waarde). "Geen env gevonden" zonder dat
 * onderscheid laat je precies de verkeerde kant op zoeken.
 */
export function explainMissingTestEnv(): string {
  const missing = REQUIRED_TEST_VARS.filter((name) => !process.env[name]);
  const present = REQUIRED_TEST_VARS.filter((name) => process.env[name]);
  const files = process.env['INTAKE_ENV_FILES_LOADED'];

  const lines = [
    `Ontbreekt: ${missing.join(', ') || '(niets — dit zou niet moeten gebeuren)'}`,
    present.length > 0 ? `Wel gevonden: ${present.join(', ')}` : 'Geen van de drie gevonden.',
    files
      ? `Gelezen env-bestanden: ${files}`
      : 'Er is geen .env-bestand gelezen. Verwacht op de repo-root; ' +
        'controleer of packages/db/vitest.config.ts de setupFiles laadt.',
  ];

  return lines.join('\n');
}

export function serviceClient(env: TestEnv, schema: 'public' | 'app' = 'public'): SupabaseClient {
  return createClient(env.url, env.secretKey, {
    db: { schema } as never,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonUser(env: TestEnv, schema: 'public' | 'app' = 'public'): SupabaseClient {
  return createClient(env.url, env.publishableKey, {
    db: { schema } as never,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function asUser(
  env: TestEnv,
  token: string,
  schema: 'public' | 'app' = 'public',
): SupabaseClient {
  return createClient(env.url, env.publishableKey, {
    db: { schema } as never,
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Echte inlogflow: levert een JWT dat door de auth-server is ondertekend. */
async function signIn(env: TestEnv, email: string, password: string): Promise<string> {
  const client = createClient(env.url, env.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`kon niet inloggen als ${email}: ${error?.message ?? 'geen sessie'}`);
  }
  return data.session.access_token;
}

/** Een compleet tweetenant-decor: twee kantoren, twee gebruikers, twee intakes. */
export interface Fixture {
  orgA: string;
  orgB: string;
  userA: string;
  userB: string;
  intakeA: string;
  intakeB: string;
  tokenA: string;
  tokenB: string;
  suffix: string;
}

const PASSWORD = 'Test-Isolatie-2026!aA1';

export async function createFixture(env: TestEnv): Promise<Fixture> {
  const svc = serviceClient(env);
  const suffix = Math.random().toString(36).slice(2, 10);

  const { data: orgs, error: orgErr } = await svc
    .from('organizations')
    .insert([
      { slug: `test-a-${suffix}`, name: 'Kantoor A' },
      { slug: `test-b-${suffix}`, name: 'Kantoor B' },
    ])
    .select('id, slug');
  if (orgErr) throw new Error(`kon organisaties niet aanmaken: ${orgErr.message}`);

  const orgA = orgs!.find((o) => o.slug === `test-a-${suffix}`)!.id as string;
  const orgB = orgs!.find((o) => o.slug === `test-b-${suffix}`)!.id as string;

  const emailA = `a-${suffix}@example.test`;
  const emailB = `b-${suffix}@example.test`;
  const userA = await createAuthUser(env, emailA);
  const userB = await createAuthUser(env, emailB);

  const { error: memberErr } = await svc.from('organization_users').insert([
    { organization_id: orgA, user_id: userA, role: 'ORG_ADMIN' },
    { organization_id: orgB, user_id: userB, role: 'ORG_ADMIN' },
  ]);
  if (memberErr) throw new Error(`kon lidmaatschap niet aanmaken: ${memberErr.message}`);

  const { data: intakes, error: intakeErr } = await svc
    .from('intakes')
    .insert([
      { organization_id: orgA, client_name: 'Cliënt A', subject: 'VSO' },
      { organization_id: orgB, client_name: 'Cliënt B', subject: 'Loon' },
    ])
    .select('id, organization_id');
  if (intakeErr) throw new Error(`kon intakes niet aanmaken: ${intakeErr.message}`);

  const intakeA = intakes!.find((i) => i.organization_id === orgA)!.id as string;
  const intakeB = intakes!.find((i) => i.organization_id === orgB)!.id as string;

  return {
    orgA,
    orgB,
    userA,
    userB,
    intakeA,
    intakeB,
    tokenA: await signIn(env, emailA, PASSWORD),
    tokenB: await signIn(env, emailB, PASSWORD),
    suffix,
  };
}

export async function destroyFixture(env: TestEnv, fixture: Fixture): Promise<void> {
  const svc = serviceClient(env);
  // Cascade ruimt intakes, sessies, tokens en lidmaatschappen op.
  await svc.from('organizations').delete().in('id', [fixture.orgA, fixture.orgB]);
  const admin = createClient(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await admin.auth.admin.deleteUser(fixture.userA).catch(() => undefined);
  await admin.auth.admin.deleteUser(fixture.userB).catch(() => undefined);
}

async function createAuthUser(env: TestEnv, email: string): Promise<string> {
  const admin = createClient(env.url, env.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    password: PASSWORD,
  });
  if (error) throw new Error(`kon auth-gebruiker niet aanmaken: ${error.message}`);
  return data.user.id;
}

// ---------------------------------------------------------------- agentsessie

export interface AgentSessionFixture {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
}

/**
 * Geeft een agentsessie uit zoals apps/web dat doet: token hier genereren, alleen de
 * hash de database in. De database ziet het ruwe token nooit.
 */
export async function issueSession(
  env: TestEnv,
  args: { intakeId: string; channel?: 'video' | 'voice' | 'chat'; ttlMinutes?: number },
): Promise<AgentSessionFixture> {
  const { token, tokenHash } = await createSessionToken();
  const svc = serviceClient(env, 'app');

  const { data, error } = await svc.rpc('issue_agent_session', {
    p_intake_id: args.intakeId,
    p_channel: args.channel ?? 'video',
    p_token_hash: tokenHash,
    p_ttl_minutes: args.ttlMinutes ?? null,
    p_room_name: null,
    p_prewarmed_at: null,
  });
  if (error) throw new Error(`kon sessie niet uitgeven: ${error.message}`);

  const row = (data as { session_id: string; expires_at: string }[])[0]!;
  return { sessionId: row.session_id, sessionToken: token, expiresAt: row.expires_at };
}

/**
 * Zet een bestaand token in het verleden.
 *
 * Bewust via een directe update en niet via een negatieve TTL: issue_agent_session
 * weigert die, en dat hoort zo. Een test mag de productie-API niet slapper maken om
 * zichzelf makkelijker te maken.
 */
export async function expireSessionToken(env: TestEnv, sessionId: string): Promise<void> {
  const svc = serviceClient(env);
  const { error } = await svc
    .from('session_tokens')
    .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('session_id', sessionId);
  if (error) throw new Error(`kon token niet laten verlopen: ${error.message}`);
}

/** De agentclient: publishable key, geen Authorization-header. Het token gaat per call mee. */
export function agentClient(env: TestEnv): SupabaseClient {
  return createClient(env.url, env.publishableKey, {
    db: { schema: 'app' } as never,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
