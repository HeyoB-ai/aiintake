#!/usr/bin/env node
/**
 * Zet het demo-decor neer: Van Dijk Arbeidsrecht en vijf afgeronde intakes.
 *
 * Twee transporten, want de doelomgevingen verschillen wezenlijk:
 *
 *   PostgREST   met SUPABASE_SECRET_KEY — voor een gehost project. Dat accepteert geen
 *               losse SQL, dus een .sql-bestand komt daar sowieso niet binnen.
 *   Postgres    met SUPABASE_DB_URL of DATABASE_URL — voor een lokale of embedded
 *               database, zoals in `pnpm db:check`.
 *
 * De data staat één keer beschreven, in supabase/seed/demo-data.mjs. Dat is het punt
 * van deze opzet: twee transporten, één beschrijving.
 *
 * De seed is idempotent (upsert op de natuurlijke sleutel), dus opnieuw draaien is
 * veilig. Hij hoort niettemin alleen op een ontwikkel- of demo-omgeving.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSeed } from '../supabase/seed/demo-data.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [join(ROOT, '.env'), join(ROOT, '.env.local')]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* niets */
    }
  }
}

/** Draait de seed over een directe Postgres-verbinding. */
export async function seedOverPostgres(client, groups) {
  for (const { table, rows, conflict, json = [] } of groups) {
    for (const row of rows) {
      const columns = Object.keys(row);
      const placeholders = columns.map((c, i) =>
        json.includes(c) ? `$${i + 1}::jsonb` : `$${i + 1}`,
      );
      const values = columns.map((c) => {
        const v = row[c];
        // Een jsonb-kolom wil geldige JSON, ook voor een los getal of een boolean:
        // 3800 is geen jsonb-invoer, "3800" wel. null blijft SQL NULL.
        if (json.includes(c)) return v === null ? null : JSON.stringify(v);
        return v;
      });
      const updates = columns.filter((c) => !conflict.split(',').includes(c));

      await client.query(
        `insert into public.${table} (${columns.join(', ')})
         values (${placeholders.join(', ')})
         on conflict (${conflict}) do update set
           ${updates.map((c) => `${c} = excluded.${c}`).join(', ')}`,
        values,
      );
    }
  }
}

/** Draait de seed via PostgREST met de secret key. */
async function seedOverPostgrest(url, secretKey, groups) {
  const { createClient } = await import('@supabase/supabase-js');
  const supabase = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  for (const { table, rows, conflict } of groups) {
    const { error } = await supabase.from(table).upsert(rows, { onConflict: conflict });
    if (error) {
      throw new Error(`${table}: ${error.message}${error.details ? ` (${error.details})` : ''}`);
    }
  }
  return supabase;
}

async function main() {
  const groups = buildSeed();
  const dbUrl = process.env['SUPABASE_DB_URL'] ?? process.env['DATABASE_URL'];
  const restUrl = process.env['NEXT_PUBLIC_SUPABASE_URL'] ?? process.env['SUPABASE_URL'];
  const secretKey = process.env['SUPABASE_SECRET_KEY'];

  if (dbUrl) {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    process.stdout.write(`\nseed via Postgres -> ${new URL(dbUrl).hostname}\n`);
    try {
      await seedOverPostgres(client, groups);
      await report(async (sql) => (await client.query(sql)).rows[0]);
    } finally {
      await client.end().catch(() => undefined);
    }
    return;
  }

  if (restUrl && secretKey) {
    process.stdout.write(`\nseed via PostgREST -> ${new URL(restUrl).hostname}\n`);
    const supabase = await seedOverPostgrest(restUrl, secretKey, groups);
    const tellingen = {};
    for (const { table } of groups) {
      const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
      tellingen[table] = count ?? 0;
    }
    printCounts(tellingen);
    return;
  }

  process.stderr.write(
    [
      '',
      'Geen verbinding beschikbaar.',
      '',
      'Zet één van beide in .env:',
      '  SUPABASE_SECRET_KEY (+ NEXT_PUBLIC_SUPABASE_URL) — via PostgREST, geen databasewachtwoord nodig',
      '  SUPABASE_DB_URL                                   — directe Postgres-verbinding',
      '',
    ].join('\n'),
  );
  process.exitCode = 1;
}

async function report(query) {
  const row = await query(`
    select
      (select count(*) from public.organizations) as organizations,
      (select count(*) from public.prompt_templates) as prompt_templates,
      (select count(*) from public.intakes) as intakes,
      (select count(*) from public.case_facts) as case_facts,
      (select count(*) from public.risk_flags) as risk_flags
  `);
  printCounts(row);
}

function printCounts(counts) {
  const labels = {
    organizations: 'organisaties',
    prompt_templates: 'promptsjablonen',
    intakes: 'intakes',
    case_facts: 'feiten',
    risk_flags: 'risicovlaggen',
  };
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${labels[k] ?? k}`);
  process.stdout.write(`  ok  ${parts.join(', ')}\n\n`);
}

// Alleen draaien als dit het startpunt is; db:check importeert seedOverPostgres.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((error) => {
    process.stderr.write(`\n  FAIL ${error.message}\n\n`);
    process.exitCode = 1;
  });
}
