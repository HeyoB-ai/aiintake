import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * §11: "geen enkel codepad in apps/agent heeft de service-role key".
 *
 * Dit is een statische controle op de broncode, en dat is bewust. Een runtimetest zou
 * alleen bewijzen dat de key op dát moment niet werd gebruikt; deze test bewijst dat
 * hij nergens in de worker te bereiken is. De worker werkt met een kortlevend
 * intake-token dat hoogstens één intake kan raken — een gecompromitteerde worker mag
 * geen sleutel in handen hebben waarmee hij elke tenant kan lezen.
 *
 * Draait zonder database.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const AGENT_DIR = join(REPO_ROOT, 'apps', 'agent');

/** Patronen die de service-role key in handen van de worker zouden geven. */
const FORBIDDEN: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /SUPABASE_SECRET_KEY/,
    why: 'de secret key omzeilt RLS volledig en hoort niet in een langlevend proces',
  },
  {
    // Een echte key heeft een lange willekeurige staart. Het kale voorvoegsel komt
    // legitiem voor in de envvalidatie van de worker, die een secret key juist
    // weigert — dat is beschermende code en geen sleutel.
    pattern: /sb_secret_[A-Za-z0-9_-]{12,}/,
    why: 'een hardgecodeerde secret key',
  },
  {
    pattern: /\bservice_role\b/,
    why: 'verwijzing naar de RLS-omzeilende rol',
  },
  {
    pattern: /createServiceRoleClient/,
    why: 'de RLS-omzeilende client',
  },
  {
    pattern: /readServerEnv/,
    why: 'readServerEnv valideert onder meer de secret key',
  },
  {
    pattern: /issueAgentSession|issue_agent_session/,
    why: 'sessies uitgeven is de taak van de web-app; wie zijn eigen credential mag aanmaken, heeft er geen',
  },
  {
    pattern: /createSessionToken/,
    why: 'de worker genereert geen tokens, hij ontvangt er één per sessie',
  },
  {
    pattern: /revoke_agent_session|purge_expired_session_tokens/,
    why: 'tokenbeheer hoort bij de web-app',
  },
  {
    pattern: /session_tokens/,
    why: 'de tabel met tokenhashes is voor de worker niet bereikbaar en hoort hij niet te kennen',
  },
];

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe('apps/agent heeft geen service-role key', () => {
  const files = sourceFiles(AGENT_DIR);

  it('de agent-app bestaat en heeft broncode om te controleren', () => {
    // Anders zou deze suite groen zijn omdat er niets te vinden viel.
    expect(existsSync(AGENT_DIR)).toBe(true);
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN.map((f) => [f.pattern.source, f]))('bevat nergens %s', (_name, rule) => {
    const { pattern, why } = rule as { pattern: RegExp; why: string };
    const hits = files
      .filter((file) => pattern.test(readFileSync(file, 'utf8')))
      .map((file) => relative(REPO_ROOT, file));
    expect(hits, `${why}\nGevonden in:\n${hits.join('\n')}`).toEqual([]);
  });

  it('de env-sjabloon van de agent noemt de secret key niet', () => {
    const envExample = join(AGENT_DIR, '.env.example');
    expect(existsSync(envExample)).toBe(true);
    const body = readFileSync(envExample, 'utf8');
    expect(body).not.toMatch(/SUPABASE_SECRET_KEY/);
    expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(body).not.toMatch(/SUPABASE_JWT_SECRET/);
    // Wat er wél hoort te staan: de sleutel die publiek mag zijn.
    expect(body).toMatch(/SUPABASE_PUBLISHABLE_KEY/);
  });

  it('de agent hangt niet af van packages die de service-role client exporteren', () => {
    const pkgPath = join(AGENT_DIR, 'package.json');
    expect(existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    // @intake/db exporteert createServiceRoleClient. De agent gebruikt een eigen,
    // smallere client die alleen het RPC-oppervlak kent.
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@intake/db');
  });
});
