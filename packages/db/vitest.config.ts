import { configDefaults, defineConfig } from 'vitest/config';

/*
 * Een patroon en niet één bestandsnaam.
 *
 * Hier stond `src/__tests__/tenant-isolation.test.ts`. Een tweede isolatietest erbij
 * zetten had daardoor twee stille gevolgen tegelijk: hij draaide niet mee met
 * `pnpm test:isolation`, én hij belandde wél in `pnpm test` — waar geen testdatabase is,
 * dus sloeg hij zichzelf over. Groen op beide plekken, gemeten werd er niets.
 *
 * Elk bestand dat op `.isolation.` eindigt of in `__tests__` staat en de database nodig
 * heeft, hoort hier binnen te vallen. Vandaar een glob.
 */
export const ISOLATION_SUITE = 'src/__tests__/{tenant-isolation,dashboard-detail}.test.ts';

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
