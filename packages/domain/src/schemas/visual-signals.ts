import { z } from 'zod';

/**
 * Alles wat de browser over de datachannel mag sturen. Uitsluitend booleans —
 * er verlaat geen enkel videoframe het apparaat (§2.6).
 *
 * Deze signalen voeden UITSLUITEND het dialoogbeleid (timing, pacing, onderbreken).
 * Zij mogen nooit in `case_facts`, `risk_flags`, de samenvatting of een cold-path
 * prompt terechtkomen. Die grens wordt hieronder als type afgedwongen, niet als
 * afspraak: `FactExtractorInput` en `SummaryInput` accepteren dit type simpelweg niet.
 */
export const VisualSignalsSchema = z
  .object({
    facePresent: z.boolean(),
    userLookingAway: z.boolean().optional(),
    headNod: z.boolean().optional(),
    headShake: z.boolean().optional(),
    longPause: z.boolean().optional(),
    possibleInterruption: z.boolean().optional(),
  })
  .strict();

export type VisualSignals = z.infer<typeof VisualSignalsSchema>;

/**
 * Emotieherkenning: interface mag bestaan, implementatie niet (§2.5).
 *
 * De EU AI Act verbiedt emotieherkenning op de werkplek en merkt het daarbuiten aan
 * als hoogrisico. Een arbeidsrechtelijke intake ligt oncomfortabel dicht tegen die
 * werkplekcontext aan. Er is daarom geen implementatie in deze codebase, en de
 * build-time flag die er ooit een zou activeren staat standaard uit en is in
 * productie niet aan te zetten. Zie docs/ADR-0005-geen-emotieherkenning.md.
 *
 * Een uitgeschakelde-maar-werkende classifier is niet verdedigbaar tegenover een
 * auditor; een niet-bestaande implementatie wel.
 */
export interface EmotionExtension {
  readonly __neverImplemented: never;
}

/** Onveranderlijk false in elke build. Bewust geen env-variabele. */
export const EMOTION_RECOGNITION_ENABLED = false as const;

/**
 * Typegrens: een functie die dit type als parameter neemt, kan geen VisualSignals
 * ontvangen. Gebruikt door FactExtractor en SummaryGenerator.
 */
export type WithoutVisualSignals<T> = T extends { signals: unknown } ? never : T;
