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
  ROLE_RANK,
  ROLES,
  URGENCY_RANK,
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
  /*
   * Eerst kijken of een latere migratie de constraint heeft vervangen.
   *
   * Deze functie las alleen het oorspronkelijke `create table`-blok. Een constraint die later
   * is vervangen — `drop constraint` gevolgd door `add constraint` — bleef daardoor
   * onzichtbaar: de test meldde een verschil dat er niet was, en had bij de omgekeerde
   * wijziging een verschil gemist dat er wél was.
   *
   * De laatste `add constraint` wint, want dat is wat er in de database staat nadat alle
   * migraties zijn afgespeeld. `allMigrationSql()` leest ze op bestandsnaam, en dat is
   * dezelfde volgorde als waarin Supabase ze toepast.
   */
  const alterPatroon = new RegExp(
    `alter\\s+table\\s+(?:public\\.)?${table}\\s+add\\s+constraint[\\s\\S]*?` +
      `check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
    'gis',
  );
  const uitAlter = [...SQL.matchAll(alterPatroon)].at(-1);
  if (uitAlter?.[1] !== undefined) {
    return [...uitAlter[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  }

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

/**
 * Een rangorde die twee keer is opgeschreven, in twee talen.
 *
 * `agent_set_risk_flag` bepaalt `intakes.urgency_level` met een `case`-expressie in SQL; het
 * domein heeft `URGENCY_RANK`; en `DossierSidebar` herrekent het hoogste niveau nog eens
 * client-side uit de vlaggen. Drie antwoorden op "welke urgentie wint".
 *
 * Ze zijn het vandaag eens. Lopen ze uiteen — een vijfde niveau, een andere volgorde — dan
 * toont de lijst een andere urgentie dan de detailpagina, en dat is precies het signaal waarop
 * een advocaat zijn werkvoorraad sorteert.
 *
 * Deze test leest de SQL en legt hem naast het domein. Hij kan niet zien of de client-side
 * herberekening klopt; die gebruikt `URGENCY_RANK` en is daarmee aan het domein vast.
 */
describe('de urgentierangorde in SQL spiegelt het domein', () => {
  it('geeft dezelfde volgorde als URGENCY_RANK', () => {
    // De expressie: `when 'CRITICAL' then 3 when 'HIGH' then 2 when 'MEDIUM' then 1 else 0 end`
    const blok = /order by case f\.level([\s\S]*?)end desc/.exec(SQL);
    expect(blok, 'de rangorde-expressie staat niet meer in de migraties').not.toBeNull();

    const uitSql: Record<string, number> = { LOW: 0 };
    for (const [, niveau, rang] of blok![1]!.matchAll(/when '([A-Z]+)'\s+then\s+(\d+)/g)) {
      uitSql[niveau!] = Number(rang);
    }

    expect(uitSql).toEqual(URGENCY_RANK);
  });
});

/**
 * `ROLE_RANK` staat in TypeScript en als `app.role_rank` in SQL, met een toelichting die zegt
 * dat ze elkaar spiegelen. Niets dwong dat af.
 *
 * De UI poort erop (`requireRole`), elke RLS-policy ook. Lopen ze uiteen, dan toont het scherm
 * een actie die de database daarna weigert — of, erger, andersom.
 */
describe('de rolrangorde in SQL spiegelt het domein', () => {
  it('geeft dezelfde rangen als ROLE_RANK', () => {
    // Tot het SLUITENDE $$: de eerste is het begin van de body, en dan is er niets gevangen.
    const blok = /create or replace function app\.role_rank[\s\S]*?as \$\$([\s\S]*?)\$\$/.exec(SQL);
    expect(blok, 'app.role_rank staat niet meer in de migraties').not.toBeNull();

    const uitSql: Record<string, number> = {};
    // `\s+`, want de SQL lijnt de getallen uit met meerdere spaties.
    for (const [, rol, rang] of blok![1]!.matchAll(/when '([A-Z_]+)'\s+then\s+(\d+)/g)) {
      uitSql[rol!] = Number(rang);
    }

    expect(uitSql).toEqual(ROLE_RANK);
  });
});

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
  // De agent-functies staan in `public` (het geexposeerde schema); de guard waar ze
  // mee beginnen staat in `app` (intern). Zie docs/ADR-0008-rpc-in-public-schema.md.
  const agentFns = [...SQL.matchAll(/create or replace function public\.(agent_\w+)\s*\(/g)].map(
    (m) => m[1] as string,
  );

  it('er zijn agent-functies gedefinieerd', () => {
    expect(agentFns.length).toBeGreaterThan(5);
  });

  it.each(agentFns.map((f) => [f]))('app.%s roept assert_agent_scope aan', (fn) => {
    const start = SQL.indexOf(`create or replace function public.${fn}(`);
    const end = SQL.indexOf('$$;', start);
    const body = SQL.slice(start, end);
    expect(body).toMatch(/app\.assert_agent_scope\(/);
  });
});
