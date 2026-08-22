#!/usr/bin/env node
/**
 * Draait de volledige migratiereeks tegen een lege Postgres.
 *
 * Waarom dit bestaat: `create function ... language sql` resolvet zijn referenties al
 * bij CREATE, dus een functie die een tabel noemt die later pas wordt aangemaakt, valt
 * om op een verse database — maar niet op een database waar die tabel toevallig al
 * staat. Zulke volgordefouten zijn onzichtbaar zodra je één keer succesvol hebt
 * gemigreerd, en duiken pas weer op in de volgende verse omgeving. Meestal die van de
 * klant.
 *
 * Twee modi:
 *   DATABASE_URL gezet  → gebruik die database (CI, met een service container)
 *   anders              → start een embedded Postgres (lokaal, geen Docker nodig)
 *
 * De database wordt in beide gevallen eerst leeggemaakt.
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const BOOTSTRAP = join(ROOT, 'supabase', 'tests', 'bootstrap.sql');
const SEED = join(ROOT, 'supabase', 'seed', 'seed.sql');

const WITH_SEED = !process.argv.includes('--no-seed');

/** Zet een tekenpositie uit een Postgres-fout om in regel/kolom. */
function locate(sql, position) {
  if (!position) return null;
  const upto = sql.slice(0, Number(position) - 1);
  const lines = upto.split('\n');
  return { line: lines.length, column: (lines.at(-1) ?? '').length + 1 };
}

async function applyFile(client, path, label) {
  const sql = readFileSync(path, 'utf8');
  try {
    await client.query(sql);
    process.stdout.write(`  ok   ${label}\n`);
    return true;
  } catch (error) {
    const where = locate(sql, error.position);
    process.stdout.write(`  FAIL ${label}\n`);
    process.stdout.write(`\n       ${error.message}\n`);
    if (error.code) process.stdout.write(`       SQLSTATE ${error.code}\n`);
    if (where) process.stdout.write(`       ${label}:${where.line}:${where.column}\n`);
    if (error.detail) process.stdout.write(`       detail: ${error.detail}\n`);
    if (error.hint) process.stdout.write(`       hint: ${error.hint}\n`);
    process.stdout.write('\n');
    return false;
  }
}

/**
 * Het volledige API-oppervlak: elke functie in `public` die `anon` mag aanroepen.
 *
 * `anon` is de rol achter de publishable key, en die sleutel is publiek. Wat hier
 * staat, kan dus iedereen op internet aanroepen — de bescherming zit in wat de functie
 * zelf controleert, niet in wie hem kan bereiken.
 *
 * Deze lijst met de hand bijhouden is het punt: een nieuwe functie in `public` krijgt
 * door Supabase's default privileges automatisch EXECUTE voor anon. Vergeet je de
 * REVOKE, dan verschijnt hij hier en faalt de check.
 */
const ANON_CALLABLE = new Set([
  'create_public_intake',
  'public_org_by_slug',
  'agent_context',
  'agent_append_message',
  'agent_upsert_fact',
  'agent_set_risk_flag',
  'agent_record_metric',
  'agent_log_llm_call',
  'agent_update_progress',
  'agent_set_session_providers',
  'agent_end_session',
]);

async function checkApiSurface(client) {
  const { rows } = await client.query(`
    select p.proname as name,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by p.proname
  `);

  const anonCallable = rows.filter((r) => r.anon).map((r) => r.name);
  const unexpected = anonCallable.filter((n) => !ANON_CALLABLE.has(n));
  const missing = [...ANON_CALLABLE].filter((n) => !anonCallable.includes(n));

  process.stdout.write(
    `\n  API-oppervlak: ${anonCallable.length} functies aanroepbaar door anon\n`,
  );

  let ok = true;
  if (unexpected.length > 0) {
    process.stdout.write(
      `  FAIL onbedoeld bereikbaar voor anon: ${unexpected.join(', ')}\n` +
        '       Voeg een `revoke all on function public.<naam>(...) from public;` toe,\n' +
        '       of zet de functie in ANON_CALLABLE als dat de bedoeling is.\n',
    );
    ok = false;
  }
  if (missing.length > 0) {
    process.stdout.write(
      `  FAIL verwacht maar niet bereikbaar voor anon: ${missing.join(', ')}\n` +
        '       De GRANT ontbreekt, of de signatuur in het rechtenblok klopt niet meer.\n',
    );
    ok = false;
  }

  // Interne helpers horen in `app`, dat niet door PostgREST wordt geëxposeerd.
  const { rows: strays } = await client.query(`
    select p.proname as name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and (p.proname like 'agent\\_%' or p.proname in ('create_public_intake','issue_agent_session'))
    order by p.proname
  `);
  if (strays.length > 0) {
    process.stdout.write(
      `  FAIL client-gerichte functies staan nog in app: ${strays.map((s) => s.name).join(', ')}\n`,
    );
    ok = false;
  }

  return ok;
}

async function run(connectionString) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  // Supabase draait op UTF8. Zonder dit klaagt een cluster dat op Windows met WIN1252
  // is geïnitialiseerd over elk niet-ASCII teken in een comment, en dan test je iets
  // anders dan de doelomgeving.
  await client.query("set client_encoding to 'UTF8'");

  // Volledig leeg beginnen. Zonder dit test je tegen de restanten van de vorige run,
  // en dat is precies de situatie die deze check moet uitsluiten.
  await client.query(`
    drop schema if exists app cascade;
    drop schema if exists auth cascade;
    drop schema if exists storage cascade;
    drop schema if exists extensions cascade;
    drop schema if exists public cascade;
    create schema public;
  `);

  process.stdout.write('\nmigratiereeks tegen een lege database\n\n');

  let ok = await applyFile(client, BOOTSTRAP, 'bootstrap.sql');

  if (ok) {
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) throw new Error('geen migraties gevonden');

    for (const file of files) {
      ok = await applyFile(client, join(MIGRATIONS_DIR, file), file);
      if (!ok) break;
    }
  }

  // De seed hoort ook tegen een verse database te werken; hij gebruikt dezelfde
  // constraints als de applicatie.
  if (ok && WITH_SEED) {
    ok = await applyFile(client, SEED, 'seed/seed.sql');
  }

  if (ok) {
    const { rows } = await client.query(`
      select
        (select count(*) from pg_tables where schemaname = 'public') as tabellen,
        (select count(*) from pg_policies where schemaname = 'public') as policies,
        (select count(*) from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'app') as functies
    `);
    const r = rows[0];
    process.stdout.write(
      `\n  ${r.tabellen} tabellen, ${r.policies} policies, ${r.functies} app-functies\n`,
    );

    ok = (await checkApiSurface(client)) && ok;

    // Een tabel zonder RLS is hier een fout, niet een waarschuwing.
    const { rows: unprotected } = await client.query(`
      select tablename from pg_tables t
      where schemaname = 'public'
        and not exists (
          select 1 from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = t.tablename and c.relrowsecurity
        )
      order by tablename
    `);
    if (unprotected.length > 0) {
      process.stdout.write(
        `\n  FAIL tabellen zonder row level security: ${unprotected.map((u) => u.tablename).join(', ')}\n`,
      );
      ok = false;
    }
  }

  await client.end();
  return ok;
}

/**
 * Dit script dropt schema's. Dat is precies de bedoeling — je kunt migratievolgorde
 * niet testen op een database waar de tabellen al staan — maar het is ook onherstelbaar
 * als iemand hier een echte DATABASE_URL op richt.
 *
 * Daarom: de databasenaam moet 'test' bevatten, tenzij expliciet geforceerd. Een
 * flauwe controle, en dat is genoeg: hij kost niets en vangt de fout die je hier
 * daadwerkelijk maakt, namelijk een omgevingsvariabele die nog van iets anders openstond.
 */
function assertDisposable(connectionString) {
  if (process.argv.includes('--force')) return;

  let name = '';
  try {
    name = new URL(connectionString).pathname.replace(/^\//, '');
  } catch {
    throw new Error('DATABASE_URL is geen geldige URL');
  }

  if (!/test/i.test(name)) {
    throw new Error(
      `weigert te draaien tegen database "${name}": dit script dropt schema's.\n` +
        'Gebruik een database met "test" in de naam, of geef --force als je zeker weet ' +
        'dat deze database weg mag.',
    );
  }
}

/** Laat het OS een vrije poort kiezen en geef die weer vrij. */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  if (process.env.DATABASE_URL) {
    assertDisposable(process.env.DATABASE_URL);
    process.stdout.write('database: DATABASE_URL\n');
    const ok = await run(process.env.DATABASE_URL);
    process.exit(ok ? 0 : 1);
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const dataDir = mkdtempSync(join(tmpdir(), 'intake-pg-'));

  // Een vrije poort opvragen in plaats van een vaste. Blijft er ooit een postgres
  // hangen — een afgebroken run, een crash — dan mislukt de volgende run anders met
  // "could not bind", wat eruitziet als een migratiefout terwijl het er geen is.
  const port = await freePort();

  process.stdout.write('database: embedded Postgres (geen DATABASE_URL gezet)\n');
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });

  let ok = false;
  try {
    await server.initialise();
    await server.start();

    // Expliciet UTF8 met template0: initdb kiest op Windows anders de
    // systeemcodepagina (WIN1252), en dan valt elk accent of pijltje in een SQL-comment
    // om op een encodingfout die op Supabase nooit zou optreden.
    const admin = new pg.Client({
      connectionString: `postgresql://postgres:postgres@localhost:${port}/postgres`,
    });
    await admin.connect();
    await admin.query('drop database if exists migratietest');
    await admin.query("create database migratietest encoding 'UTF8' template template0");
    await admin.end();

    ok = await run(`postgresql://postgres:postgres@localhost:${port}/migratietest`);
  } finally {
    await server.stop().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\n${error?.stack ?? error}\n`);
  process.exit(1);
});
