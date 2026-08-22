import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Laadt `.env` van de repo-root in `process.env` vóór de testbestanden.
 *
 * Zelfde reden als in packages/db: vitest doet dit niet uit zichzelf, want Vite leest
 * `.env` alleen voor `VITE_`-variabelen in `import.meta.env`. De integratietests
 * evalueren hun skip-conditie op moduleniveau, dus dit moet een setupFile zijn.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');

const loaded: string[] = [];
for (const path of [join(ROOT, '.env'), join(ROOT, '.env.local')]) {
  if (!existsSync(path)) continue;
  try {
    process.loadEnvFile(path);
    loaded.push(path);
  } catch {
    /* niets */
  }
}

process.env['INTAKE_ENV_FILES_LOADED'] = loaded.join(', ');
