import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const monorepoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Zonder dit kiest Next de dichtstbijzijnde lockfile als projectroot, en die kan
  // buiten deze monorepo liggen (bijvoorbeeld een package-lock.json in de home-map).
  // Dan komen er bestanden in de output-tracing die er niet horen.
  outputFileTracingRoot: monorepoRoot,
  transpilePackages: ['@intake/db', '@intake/db-core', '@intake/domain', '@intake/engine', '@intake/ui'],
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
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          // Camera en microfoon zijn nodig op de intakeroute; verder overal uit.
          // Let op: geen enkel videoframe verlaat het apparaat voor analyse — de
          // MediaPipe-analyse draait in de browser en er gaan alleen booleans over
          // de datachannel.
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(), payment=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
