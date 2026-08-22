import { configDefaults, defineConfig } from 'vitest/config';

export const ISOLATION_SUITE = 'src/__tests__/tenant-isolation.test.ts';

export default defineConfig({
  test: {
    // Draait vóór elk testbestand wordt geïmporteerd. Nodig omdat de isolatiesuite
    // zijn skip-conditie op moduleniveau evalueert: staat `.env` er dan nog niet in,
    // dan slaat hij zichzelf over terwijl de sleutels gewoon op schijf staan.
    setupFiles: ['./src/__tests__/load-env.ts'],

    // De isolatiesuite hoort niet bij `pnpm test`. Hij praat met een echte database en
    // maakt daar organisaties, gebruikers en intakes aan. Dat moet een bewuste keuze
    // zijn — `pnpm test:isolation` — en geen bijwerking van een routineuze testrun,
    // zeker nu .env wel wordt ingelezen en hij dus niet meer vanzelf overslaat.
    exclude: [...configDefaults.exclude, ISOLATION_SUITE],
  },
});
