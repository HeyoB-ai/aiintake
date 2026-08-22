import { defineConfig } from 'vitest/config';

/**
 * Alleen de bakeoff. Apart omdat hij avatarminuten kost en omdat de meting vanaf een
 * machine in Nederland moet komen — niet vanuit een CI-runner in een willekeurige regio.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/test-support/load-env.ts'],
    include: ['src/avatar/bakeoff*.integration.test.ts'],
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
