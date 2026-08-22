import { defineConfig } from 'vitest/config';
import { INTEGRATION_SUITE } from './vitest.config';

/**
 * De integratietests: echte leveranciers, echte latency.
 *
 * Apart van `pnpm test` omdat ze credits kosten en netwerk nodig hebben. Dit is ook de
 * harnas waarop de bakeoff straks draait — dezelfde meting, andere avatarprovider.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/test-support/load-env.ts'],
    include: [INTEGRATION_SUITE],
    // Eén tegelijk: parallelle streams vertekenen de latencymeting.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
