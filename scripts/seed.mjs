#!/usr/bin/env node
/**
 * Draait supabase/seed/seed.sql tegen het gekoppelde project.
 *
 * Waarom een eigen script: `supabase db push` past alleen migraties toe, geen seeds, en
 * PostgREST kan geen willekeurige SQL uitvoeren — de secret key helpt hier dus niet.
 * Er is een echte databaseverbinding nodig.
 *
 * Het SQL-bestand blijft de enige bron van waarheid. De alternatieve route — de seed
 * nog een keer schrijven met supabase-js — zou twee versies opleveren die na de eerste
 * wijziging uit elkaar lopen.
 *
 * De seed is idempotent (`on conflict do nothing` / `do update`), dus opnieuw draaien is
 * veilig. Hij hoort niettemin alleen op een ontwikkel- of demo-omgeving.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SEED = join(ROOT, 'supabase', 'seed', 'seed.sql');

for (const file of [join(ROOT, '.env'), join(ROOT, '.env.local')]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* leeg of onleesbaar; de foutmelding hieronder is duidelijk genoeg */
    }
  }
}

const url = process.env['SUPABASE_DB_URL'] ?? process.env['DATABASE_URL'];

if (!url) {
  process.stderr.write(
    [
      '',
      'SUPABASE_DB_URL ontbreekt.',
      '',
      'De seed heeft een echte databaseverbinding nodig; een API-key volstaat niet,',
      'want PostgREST voert geen losse SQL uit.',
      '',
      'Te vinden in Supabase: Project Settings -> Database -> Connection string -> URI.',
      'Neem de session pooler (poort 5432 of 6543) en zet hem in .env:',
      '',
      '  SUPABASE_DB_URL=postgresql://postgres.<ref>:<wachtwoord>@<host>:5432/postgres',
      '',
      'Dit is een databasewachtwoord, geen API-key. Het hoort in .env en nergens anders.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

const target = (() => {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return '(onleesbare URL)';
  }
})();

const client = new pg.Client({
  connectionString: url,
  // Supabase vereist TLS; het certificaat is van een keten die node niet standaard
  // kent op elke omgeving, en dit is een beheertaak op een bekende host.
  ssl: { rejectUnauthorized: false },
});

process.stdout.write(`\nseed -> ${target}\n\n`);

try {
  await client.connect();
  await client.query("set client_encoding to 'UTF8'");
  await client.query(readFileSync(SEED, 'utf8'));

  const { rows } = await client.query(`
    select
      (select count(*) from public.organizations) as organisaties,
      (select count(*) from public.intakes) as intakes,
      (select count(*) from public.case_facts) as feiten,
      (select count(*) from public.risk_flags) as risicovlaggen,
      (select count(*) from public.prompt_templates) as promptsjablonen
  `);
  const r = rows[0];
  process.stdout.write(
    `  ok  ${r.organisaties} organisaties, ${r.intakes} intakes, ${r.feiten} feiten, ` +
      `${r.risicovlaggen} risicovlaggen, ${r.promptsjablonen} promptsjablonen\n\n`,
  );
} catch (error) {
  process.stderr.write(`\n  FAIL ${error.message}\n`);
  if (error.code) process.stderr.write(`       SQLSTATE ${error.code}\n`);
  if (error.detail) process.stderr.write(`       detail: ${error.detail}\n`);
  process.stderr.write('\n');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
