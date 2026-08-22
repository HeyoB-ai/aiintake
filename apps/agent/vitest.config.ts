import { configDefaults, defineConfig } from 'vitest/config';

export const INTEGRATION_SUITE = 'src/**/*.integration.test.ts';

export default defineConfig({
  test: {
    setupFiles: ['./src/test-support/load-env.ts'],
    // Integratietests praten met echte leveranciers en kosten geld en tijd. Dat hoort
    // een bewuste keuze te zijn (`pnpm test:pipeline`) en geen bijwerking van `pnpm test`.
    exclude: [...configDefaults.exclude, INTEGRATION_SUITE],
  },
});
