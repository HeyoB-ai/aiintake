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
  // Alleen controleren, geen neveneffect: nodig op het moment dat de client de
  // realtime-verbinding opent, wanneer er nog geen beurt en geen metriek is.
  'agent_verify_session',
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

/**
 * Verlopen sessies mogen de limiet niet blijven vullen.
 *
 * ## Waarom dit hier staat en niet bij de isolatietests
 *
 * Die draaien tegen een echt Supabase-project en slaan zichzelf over zonder secrets. Deze
 * controle bewaakt de reden waarom de dienst op productie stil kwam te liggen; hij hoort
 * te draaien in elke CI-run, ook op een fork zonder sleutels. Hier is een echte Postgres
 * met de volledige migratiereeks, en dat is alles wat nodig is.
 *
 * ## Wat er gebeurd was
 *
 * `issue_agent_session` telde `ended_at is null` zonder tijdsgrens. Sessies die nooit
 * werden afgesloten — een crash, een deploy, een foutpad dat vóór het afsluiten stopte —
 * telden voor altijd mee. Bij `maxConcurrentSessions: 5` waren vijf van zulke rijen genoeg
 * om niemand meer een gesprek te laten beginnen.
 *
 * De test zet vijf sessies neer die ruim over hun levensduur heen zijn en vraagt dan een
 * zesde aan. Zonder het verval faalt dat met 53400.
 */
async function checkSessieVerval(client) {
  const { rows: org } = await client.query(
    `select id, coalesce((session_limits ->> 'maxSessionMinutes')::int, 25) as minuten
       from public.organizations order by created_at limit 1`,
  );
  if (org.length === 0) {
    process.stdout.write('\n  (geen organisatie in de seed; sessieverval niet getoetst)\n');
    return true;
  }
  const orgId = org[0].id;

  const { rows: intake } = await client.query(
    `select id from public.intakes where organization_id = $1 and deleted_at is null limit 1`,
    [orgId],
  );
  if (intake.length === 0) {
    process.stdout.write('\n  (geen intake in de seed; sessieverval niet getoetst)\n');
    return true;
  }
  const intakeId = intake[0].id;

  // Ruim voorbij maxSessionMinutes + 5, zodat de grens zelf niet het onderwerp is.
  const oud = `now() - interval '${org[0].minuten + 60} minutes'`;
  await client.query(
    `insert into public.sessions (organization_id, intake_id, channel, started_at)
     select $1, $2, 'video', ${oud} from generate_series(1, 5)`,
    [orgId, intakeId],
  );

  const hash = 'a'.repeat(64);
  try {
    await client.query(
      `select public.issue_agent_session($1::uuid, 'video', $2::text, null, null, null)`,
      [intakeId, hash],
    );
  } catch (error) {
    process.stdout.write(
      `\n  FAIL verlopen sessies vullen de limiet nog steeds: ${error.message}\n`,
    );
    return false;
  }

  const { rows: open } = await client.query(
    `select count(*)::int as n from public.sessions
      where organization_id = $1 and ended_at is null`,
    [orgId],
  );
  // De vijf oude rijen zijn dicht, de nieuwe staat open.
  if (open[0].n !== 1) {
    process.stdout.write(
      `\n  FAIL na het uitgeven staan er ${open[0].n} sessies open in plaats van 1\n`,
    );
    return false;
  }

  const { rows: reden } = await client.query(
    `select count(*)::int as n from public.sessions
      where organization_id = $1 and end_reason = 'timeout' and billed_seconds is null`,
    [orgId],
  );
  if (reden[0].n !== 5) {
    process.stdout.write(
      `\n  FAIL ${reden[0].n} van de 5 verlopen sessies kregen end_reason 'timeout'\n`,
    );
    return false;
  }

  process.stdout.write('\n  Sessieverval: 5 verlopen rijen opgeruimd, de zesde kon starten\n');
  return true;
}

/**
 * De naam is een grens in de database, niet alleen in het formulier.
 *
 * Het toestemmingsscherm zet de knop op disabled zolang er geen naam staat. Dat is een
 * gemak voor wie invult. Zou dat de enige plek zijn, dan is de regel te omzeilen door de
 * server action rechtstreeks aan te roepen.
 *
 * Contactgegevens zijn géén eis, en dat wordt hier ook getoetst — een aanvraag met alleen
 * een naam hoort te slagen. Die eis heeft één dag bestaan en is vervallen omdat het scherm
 * de velden als optioneel presenteerde; deze controle houdt vast dat hij niet terugsluipt
 * zonder dat het scherm meeverandert.
 */
async function checkContactVerplicht(client) {
  const { rows: org } = await client.query(
    `select slug from public.organizations where is_active and deleted_at is null
      order by created_at limit 1`,
  );
  if (org.length === 0) {
    process.stdout.write('\n  (geen organisatie in de seed; contactplicht niet getoetst)\n');
    return true;
  }
  const slug = org[0].slug;

  // De rate limiter telt per IP-hash; een eigen hash per poging houdt deze controle
  // onafhankelijk van de drempel.
  let teller = 0;
  const roep = (naam, email, telefoon) =>
    client.query(
      `select public.create_public_intake(
         $1::text, 'nl', 'video', $2::text, true, 'v1', true, 'v1', false, true, null,
         $3::text, $4::text, $5::text)`,
      [slug, `contactcheck-${teller++}`, naam, email, telefoon],
    );

  const geweigerd = [
    ['zonder naam', null, 'sanne@voorbeeld.nl', null],
    ['met alleen witruimte als naam', '   ', null, '0612345678'],
    ['met een naam van één teken', 'S', null, '0612345678'],
    ['met een onzinnig e-mailadres', 'Sanne de Vries', 'sanne-apenstaartje', null],
  ];

  for (const [wat, naam, email, telefoon] of geweigerd) {
    try {
      await roep(naam, email, telefoon);
      process.stdout.write(`\n  FAIL create_public_intake accepteerde een intake ${wat}\n`);
      return false;
    } catch (error) {
      if (error.code !== '22023') {
        process.stdout.write(
          `\n  FAIL intake ${wat} faalde met ${error.code} in plaats van 22023: ${error.message}\n`,
        );
        return false;
      }
    }
  }

  // Alleen een naam, geen contact. Dit hoort te slagen; het is de hele reden dat de eis
  // op e-mail-óf-telefoon is vervallen.
  try {
    await roep('Ada zonder Contact', null, null);
  } catch (error) {
    process.stdout.write(
      `\n  FAIL een intake met alleen een naam werd geweigerd: ${error.message}\n`,
    );
    return false;
  }

  try {
    await roep('Sanne de Vries', '  SANNE@Voorbeeld.NL ', '0612345678');
  } catch (error) {
    process.stdout.write(`\n  FAIL een volledige intake werd geweigerd: ${error.message}\n`);
    return false;
  }

  const { rows } = await client.query(
    `select client_name, client_email, client_phone from public.intakes
      where client_name = 'Sanne de Vries' order by created_at desc limit 1`,
  );
  const r = rows[0];
  if (!r || r.client_phone !== '0612345678') {
    process.stdout.write('\n  FAIL naam en telefoon zijn niet op de intake beland\n');
    return false;
  }
  // Genormaliseerd: getrimd en kleingeletterd, zodat twee keer hetzelfde adres in een
  // export ook twee keer hetzelfde is.
  if (r.client_email !== 'sanne@voorbeeld.nl') {
    process.stdout.write(`\n  FAIL e-mailadres niet genormaliseerd: "${r.client_email}"\n`);
    return false;
  }

  const { rows: leeg } = await client.query(
    `select client_email, client_phone from public.intakes
      where client_name = 'Ada zonder Contact' limit 1`,
  );
  // Lege invoer hoort als null in de kolom te staan en niet als lege string: in een export
  // is dat verschil niet te zien, en "niets opgegeven" moet leesbaar blijven.
  if (!leeg[0] || leeg[0].client_email !== null || leeg[0].client_phone !== null) {
    process.stdout.write('\n  FAIL ontbrekend contact staat niet als null in de kolom\n');
    return false;
  }

  process.stdout.write(
    '\n  Naamplicht: 4 ongeldige aanvragen geweigerd, alleen-naam toegestaan, contact genormaliseerd\n',
  );
  return true;
}

/**
 * Eén gesprek erin, en nakijken wat er in `messages` staat.
 *
 * ## Waarom deze controle er zo uitziet
 *
 * `agent_append_message` bestond sinds Fase 0 en werd nooit aangeroepen. Vier keer deze
 * week bleek een groene uitkomst niets te bewijzen omdat de controle het gedrag niet raakte
 * — een cache die oversloeg, een fake die minder kon dan het contract, een tabel met nul
 * metingen, een test die in beide toestanden groen bleef. Daarom staat hier een negatieve
 * controle vóór de positieve: eerst bewijzen dat de deur op slot zit, dan pas dat de sleutel
 * past. Slaagt een schrijfpoging met een onzintoken, dan zegt de rest van deze functie niets.
 *
 * Draait tegen de embedded Postgres uit db:check, dus zonder Supabase-secrets en in elke
 * CI-run.
 */
async function checkTranscript(client) {
  const { createHash, randomBytes } = await import('node:crypto');

  /** Eén regel uitvoer, met een lege regel ervoor als dat de eerste is van een blok. */
  const meld = (tekst, metWitregel = true) => {
    process.stdout.write(`${metWitregel ? '\n' : ''}  ${tekst}\n`);
  };

  const { rows: org } = await client.query(
    `select slug from public.organizations where is_active and deleted_at is null
      order by created_at limit 1`,
  );
  if (org.length === 0) {
    meld('(geen organisatie in de seed; transcript niet getoetst)');
    return true;
  }

  const { rows: gemaakt } = await client.query(
    `select * from public.create_public_intake(
       $1::text, 'nl', 'video', 'transcriptcheck', true, 'v1', true, 'v1', false, true, null,
       'Sanne de Vries', null, '0612345678')`,
    [org[0].slug],
  );
  const intakeId = gemaakt[0].intake_id;

  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  await client.query(
    `select * from public.issue_agent_session($1::uuid, 'video', $2::text, null, null, null)`,
    [intakeId, hash],
  );

  // --- negatieve controle: een onzintoken mag niets kunnen schrijven
  try {
    await client.query(
      `select public.agent_append_message($1::text, $2::uuid, 0, 'client', 'zou niet mogen')`,
      ['dit-is-geen-geldig-token', intakeId],
    );
    meld('FAIL een ongeldig sessietoken kon in het transcript schrijven');
    return false;
  } catch {
    /* precies goed: geweigerd */
  }

  // --- het gesprek zoals de lus het wegschrijft
  const schrijf = (index, role, content, extra = {}) =>
    client.query(
      `select public.agent_append_message(
         $1::text, $2::uuid, $3::int, $4::text, $5::text, $6::text, $7::int, $8::int)`,
      [
        token,
        intakeId,
        index,
        role,
        content,
        extra.intended ?? null,
        extra.knip ?? null,
        extra.spokenMs ?? null,
      ],
    );

  await schrijf(0, 'assistant', 'Goedemiddag, Sanne de Vries. Ik ben de AI-intake-assistent.');
  await schrijf(1, 'client', 'Ik ben op staande voet ontslagen.');
  await schrijf(1, 'assistant', '[erkenning] Dat is schrikken.');
  await schrijf(1, 'assistant', 'Wanneer is dat gebeurd?', {
    intended: 'Wanneer is dat gebeurd? En had u al een waarschuwing gehad?',
    knip: 22,
    spokenMs: 900,
  });

  const { rows } = await client.query(
    `select turn_index, role, content, interrupted_at_char, intended_content
       from public.messages where intake_id = $1
      order by turn_index, created_at, id`,
    [intakeId],
  );

  if (rows.length !== 4) {
    meld(`FAIL ${rows.length} berichten in plaats van 4`);
    return false;
  }

  const volgorde = rows.map((r) => `${r.turn_index}:${r.role}`).join(' ');
  if (volgorde !== '0:assistant 1:client 1:assistant 1:assistant') {
    meld(`FAIL verkeerde volgorde of rollen: ${volgorde}`);
    return false;
  }

  // De erkenning is als eigen bericht herkenbaar. Dat is het tweede slot uit risico 16:
  // assistent-beurten zijn al uitgesloten van extractie, en dit maakt het ook leesbaar.
  const erkenning = rows[2];
  if (!erkenning.content.startsWith('[erkenning] ')) {
    meld('FAIL de erkenning staat niet als eigen gemarkeerd bericht');
    return false;
  }
  if (erkenning.interrupted_at_char !== null) {
    meld('FAIL de erkenning draagt een afkapping die er niet was');
    return false;
  }

  // En de afgekapte beurt houdt zijn eigen index; `content` is wat er is gehoord,
  // `intended_content` wat het model wilde zeggen.
  const antwoord = rows[3];
  if (antwoord.interrupted_at_char !== 22 || antwoord.intended_content === null) {
    meld('FAIL de afkapping van de assistent-beurt is niet bewaard');
    return false;
  }
  if (antwoord.intended_content.length <= antwoord.content.length) {
    meld('FAIL intended_content is niet langer dan wat er is gehoord');
    return false;
  }

  meld('Transcript: 4 berichten, juiste volgorde en rollen, erkenning gemarkeerd,');
  meld('            afkapping bewaard, ongeldig token geweigerd', false);
  return true;
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

  // De seed hoort ook tegen een verse database te werken: hij loopt tegen dezelfde
  // constraints aan als de applicatie, en case_facts_traceable weigert een vastgesteld
  // feit zonder herkomst. Zelfde data als `pnpm db:seed`, ander transport.
  if (ok && WITH_SEED) {
    try {
      const { buildSeed } = await import('../supabase/seed/demo-data.mjs');
      const { seedOverPostgres } = await import('./seed.mjs');
      await seedOverPostgres(client, buildSeed());
      process.stdout.write('  ok   demo-seed\n');
    } catch (error) {
      process.stdout.write(`  FAIL demo-seed\n\n       ${error.message}\n\n`);
      ok = false;
    }
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

    ok = (await checkSessieVerval(client)) && ok;
    ok = (await checkContactVerplicht(client)) && ok;
    ok = (await checkTranscript(client)) && ok;
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
