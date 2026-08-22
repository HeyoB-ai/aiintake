import { defineConfig } from 'vitest/config';
import { ISOLATION_SUITE } from './vitest.config';

/**
 * Alleen de tenant-isolatiesuite, tegen een echte database.
 *
 * Aparte config omdat deze tests bewust buiten `pnpm test` vallen: ze praten met een
 * Supabase-project en maken daar data aan. Gebruik `pnpm test:isolation`.
 */
export default defineConfig({
  test: {
    setupFiles: ['./src/__tests__/load-env.ts'],
    include: [ISOLATION_SUITE],
    // Eén bestand, en het maakt gedeelde fixtures aan: parallel draaien zou twee
    // runs door elkaars organisaties laten lopen.
    fileParallelism: false,
    // Netwerk naar een EU-regio; de standaard van 5 seconden is te krap voor het
    // opzetten van het decor.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
