import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Laadt `.env` in `process.env` vóórdat de testbestanden worden geïmporteerd.
 *
 * Vitest doet dit niet uit zichzelf: Vite leest `.env` wel, maar injecteert daaruit
 * alleen `VITE_`-variabelen in `import.meta.env` en laat `process.env` ongemoeid. De
 * isolatiesuite evalueert zijn skip-conditie op moduleniveau, dus dit moet gebeurd zijn
 * voordat het testbestand wordt geladen — vandaar `setupFiles` en niet `beforeAll`.
 *
 * Precedentie: variabelen die al in de omgeving staan, winnen. Zo kun je in CI met
 * secrets werken zonder dat een lokaal `.env`-bestand daar iets aan verandert.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/** Latere bestanden vullen alleen aan wat eerdere nog niet hebben gezet. */
const CANDIDATES = [
  join(REPO_ROOT, '.env'),
  join(REPO_ROOT, '.env.local'),
  join(HERE, '..', '..', '.env'),
];

const loaded: string[] = [];

for (const path of CANDIDATES) {
  if (!existsSync(path)) continue;
  try {
    // Node 22: geen dotenv-dependency nodig. Zelfde parser als `node --env-file`.
    process.loadEnvFile(path);
    loaded.push(path);
  } catch (error) {
    process.stderr.write(
      `[env] kon ${path} niet lezen: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/**
 * Zodat de skip-melding kan laten zien of er überhaupt een bestand is gelezen. Het
 * verschil tussen "de variabele ontbreekt" en "het bestand is niet ingelezen" is
 * precies wat je wilt weten als de suite onverwacht overslaat.
 */
process.env['INTAKE_ENV_FILES_LOADED'] = loaded.join(', ');

/**
 * `INTAKE_ENV_DEBUG=1` laat zien wat er is ingelezen, zonder een database aan te raken.
 * Handig als de isolatiesuite onverwacht overslaat: dan zie je meteen of het aan het
 * bestand ligt of aan een variabele.
 *
 * Drukt uitsluitend namen en lengtes af. Nooit waarden — dit zijn sleutels.
 */
if (process.env['INTAKE_ENV_DEBUG']) {
  const names = ['SUPABASE_TEST_URL', 'SUPABASE_TEST_PUBLISHABLE_KEY', 'SUPABASE_TEST_SECRET_KEY'];
  const report = names
    .map((name) => {
      const value = process.env[name];
      return `  ${value ? 'OK  ' : 'MIST'} ${name}${value ? ` (${value.length} tekens)` : ''}`;
    })
    .join('\n');
  process.stderr.write(
    `[env] gelezen: ${loaded.join(', ') || '(geen bestand gevonden)'}\n${report}\n`,
  );
}
