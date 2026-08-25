import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/*
 * De .env uit de hoofdmap inlezen.
 *
 * Next zoekt `.env` in de map van het project — hier `apps/web` — en die staat in deze
 * monorepo één niveau hoger, samen met de sleutels voor de worker en de diagnostiek. Zonder
 * dit start de dev-server wel op maar geeft elke route een 500 met "Your project's URL and
 * Key are required to create a Supabase client", en dat leest als een codefout terwijl het
 * een padkwestie is.
 *
 * `process.loadEnvFile` is ingebouwd in Node en volgt dezelfde regel als `--env-file`: een
 * variabele die al in de omgeving staat wint. Op een hostingomgeving, waar de sleutels via
 * de omgeving komen en dit bestand niet bestaat, verandert er dus niets — vandaar ook de
 * `try`: een ontbrekende .env is daar de normale toestand en geen fout.
 */
try {
  process.loadEnvFile(join(monorepoRoot, '.env'));
} catch {
  // Geen .env naast de repo: dan komen de variabelen uit de omgeving.
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Zonder dit kiest Next de dichtstbijzijnde lockfile als projectroot, en die kan
  // buiten deze monorepo liggen (bijvoorbeeld een package-lock.json in de home-map).
  // Dan komen er bestanden in de output-tracing die er niet horen.
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: [
    '@intake/db',
    '@intake/db-core',
    '@intake/domain',
    '@intake/engine',
    '@intake/ui',
    '@intake/client',
    '@intake/audio',
  ],
  experimental: {
    // De workspace-packages worden als bron geïmporteerd, niet als build-artefact.
    externalDir: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // Camera en microfoon zijn nodig op de intakeroute; verder overal uit.
          // Let op: geen enkel videoframe verlaat het apparaat voor analyse — de
          // MediaPipe-analyse draait in de browser en er gaan alleen booleans over
          // de datachannel.
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
