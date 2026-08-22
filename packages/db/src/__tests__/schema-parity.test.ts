import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTIONS,
  AVATAR_PROVIDERS,
  CHANNELS,
  DOCUMENT_ANALYSIS_STATUSES,
  END_REASONS,
  FACT_SOURCES,
  FACT_STATUSES,
  INTAKE_STATUSES,
  LANGUAGES,
  LLM_PURPOSES,
  MESSAGE_ROLES,
  PRACTICE_AREAS,
  ROLES,
  URGENCY_LEVELS,
  VALUE_TYPES,
} from '@intake/domain';

/**
 * De enums in packages/domain zijn de bron van waarheid; de CHECK-constraints in de
 * migraties zijn hun spiegel. Die twee lopen vroeg of laat uit elkaar — iemand voegt
 * een intakestatus toe in TypeScript en vergeet de migratie, en dan faalt het pas in
 * productie op een insert.
 *
 * Deze test draait zonder database.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'supabase', 'migrations');

function allMigrationSql(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n');
}

const SQL = allMigrationSql();

/** Isoleert het body-blok van één create table-statement. */
function tableBody(table: string): string {
  const start = SQL.indexOf(`create table if not exists public.${table} (`);
  if (start === -1) throw new Error(`tabel ${table} niet gevonden in de migraties`);
  const from = SQL.indexOf('(', start);

  let depth = 0;
  for (let i = from; i < SQL.length; i += 1) {
    const ch = SQL[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return SQL.slice(from + 1, i);
    }
  }
  throw new Error(`ongebalanceerde haakjes in create table ${table}`);
}

/** Haalt de toegestane waarden uit `check (<column> in ('a','b',...))`. */
function checkValues(table: string, column: string): string[] {
  const body = tableBody(table);
  const pattern = new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, 'is');
  const match = body.match(pattern);
  if (!match || match[1] === undefined) {
    throw new Error(`geen check-constraint gevonden voor ${table}.${column}`);
  }
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

const CASES: readonly [string, string, readonly string[]][] = [
  ['organization_users', 'role', ROLES],
  ['organizations', 'default_language', LANGUAGES],
  ['intakes', 'status', INTAKE_STATUSES],
  ['intakes', 'urgency_level', URGENCY_LEVELS],
  ['intakes', 'language', LANGUAGES],
  ['intakes', 'practice_area', PRACTICE_AREAS],
  ['messages', 'role', MESSAGE_ROLES],
  ['case_facts', 'status', FACT_STATUSES],
  ['case_facts', 'source', FACT_SOURCES],
  ['case_facts', 'value_type', VALUE_TYPES],
  ['risk_flags', 'level', URGENCY_LEVELS],
  ['sessions', 'channel', CHANNELS],
  ['sessions', 'end_reason', END_REASONS],
  ['sessions', 'avatar_provider', AVATAR_PROVIDERS],
  ['llm_calls', 'purpose', LLM_PURPOSES],
  ['documents', 'analysis_status', DOCUMENT_ANALYSIS_STATUSES],
  ['audit_log', 'action', AUDIT_ACTIONS],
];

describe('SQL-constraints spiegelen de domeinenums', () => {
  it.each(CASES)('%s.%s', (table, column, expected) => {
    expect(new Set(checkValues(table, column))).toEqual(new Set(expected));
  });
});

describe('RLS staat aan op elke tabel', () => {
  it('elke create table heeft een bijbehorende enable row level security', () => {
    const created = [...SQL.matchAll(/create table if not exists public\.(\w+)/g)].map(
      (m) => m[1] as string,
    );
    const rlsEnabled = new Set(
      [...SQL.matchAll(/alter table public\.(\w+)\s+enable row level security/g)].map(
        (m) => m[1] as string,
      ),
    );

    const missing = created.filter((t) => !rlsEnabled.has(t));
    expect(missing).toEqual([]);
    expect(created.length).toBeGreaterThan(10);
  });
});

describe('de agent-RPC bewaakt zijn eigen reikwijdte', () => {
  const agentFns = [...SQL.matchAll(/create or replace function app\.(agent_\w+)\s*\(/g)].map(
    (m) => m[1] as string,
  );

  it('er zijn agent-functies gedefinieerd', () => {
    expect(agentFns.length).toBeGreaterThan(5);
  });

  it.each(agentFns.map((f) => [f]))('app.%s roept assert_agent_scope aan', (fn) => {
    const start = SQL.indexOf(`create or replace function app.${fn}(`);
    const end = SQL.indexOf('$$;', start);
    const body = SQL.slice(start, end);
    expect(body).toMatch(/app\.assert_agent_scope\(/);
  });
});
