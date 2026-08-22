import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SignJWT } from 'jose';

/**
 * Testharnas voor de tenant-isolatietests.
 *
 * Deze tests draaien tegen een échte Supabase-database, niet tegen een mock. Dat is
 * geen keuze maar een noodzaak: RLS-policies zijn Postgres-gedrag, en een mock die
 * ze nabootst test alleen de mock. Zonder database worden ze overgeslagen met een
 * expliciete melding — nooit stilzwijgend groen.
 *
 * Benodigde env (zie .env.example):
 *   SUPABASE_TEST_URL
 *   SUPABASE_TEST_SERVICE_ROLE_KEY
 *   SUPABASE_TEST_ANON_KEY
 *   SUPABASE_TEST_JWT_SECRET
 */

export interface TestEnv {
  url: string;
  serviceRoleKey: string;
  anonKey: string;
  jwtSecret: string;
}

export function readTestEnv(): TestEnv | null {
  const url = process.env['SUPABASE_TEST_URL'];
  const serviceRoleKey = process.env['SUPABASE_TEST_SERVICE_ROLE_KEY'];
  const anonKey = process.env['SUPABASE_TEST_ANON_KEY'];
  const jwtSecret = process.env['SUPABASE_TEST_JWT_SECRET'];
  if (!url || !serviceRoleKey || !anonKey || !jwtSecret) return null;
  return { url, serviceRoleKey, anonKey, jwtSecret };
}

export function serviceClient(env: TestEnv): SupabaseClient {
  return createClient(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Mint een gebruikers-JWT rechtstreeks in plaats van via een inlogflow. Scheelt een
 * mailbox en test exact wat we willen testen: wat een geldig gebruikerstoken mag.
 */
export async function userToken(env: TestEnv, userId: string): Promise<string> {
  const key = new TextEncoder().encode(env.jwtSecret);
  return new SignJWT({ role: 'authenticated', aud: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(key);
}

export function asUser(
  env: TestEnv,
  token: string,
  schema: 'public' | 'app' = 'public',
): SupabaseClient {
  return createClient(env.url, env.anonKey, {
    db: { schema } as never,
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

export function anonUser(env: TestEnv, schema: 'public' | 'app' = 'public'): SupabaseClient {
  return createClient(env.url, env.anonKey, {
    db: { schema } as never,
    auth: { persistSession: false, autoRefreshToken: false },
  });
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

  const userA = await createAuthUser(svc, `a-${suffix}@example.test`);
  const userB = await createAuthUser(svc, `b-${suffix}@example.test`);

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
    tokenA: await userToken(env, userA),
    tokenB: await userToken(env, userB),
    suffix,
  };
}

export async function destroyFixture(env: TestEnv, fixture: Fixture): Promise<void> {
  const svc = serviceClient(env);
  // Cascade ruimt intakes, lidmaatschappen en kindrijen op.
  await svc.from('organizations').delete().in('id', [fixture.orgA, fixture.orgB]);
  await svc.auth.admin.deleteUser(fixture.userA).catch(() => undefined);
  await svc.auth.admin.deleteUser(fixture.userB).catch(() => undefined);
}

async function createAuthUser(svc: SupabaseClient, email: string): Promise<string> {
  const { data, error } = await svc.auth.admin.createUser({
    email,
    email_confirm: true,
    password: `Test!${Math.random().toString(36).slice(2)}Aa1`,
  });
  if (error) throw new Error(`kon auth-gebruiker niet aanmaken: ${error.message}`);
  return data.user.id;
}

/** Mint een agent-token voor één intake — dezelfde vorm als packages/db/src/agent-token.ts. */
export async function agentToken(
  env: TestEnv,
  args: { intakeId: string; organizationId: string; sessionId: string },
): Promise<string> {
  const key = new TextEncoder().encode(env.jwtSecret);
  return new SignJWT({
    role: 'authenticated',
    aud: 'authenticated',
    token_type: 'intake_agent',
    intake_id: args.intakeId,
    organization_id: args.organizationId,
    session_id: args.sessionId,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(args.sessionId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 900)
    .sign(key);
}
