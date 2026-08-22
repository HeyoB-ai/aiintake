import { z } from 'zod';
import { PracticeAreaSchema, UrgencyLevelSchema } from '../enums';
import type { FactCondition } from '../facts/catalog';

/**
 * Een intaketemplate beschrijft WELKE feiten nodig zijn en in welke volgorde ze bij
 * gelijke score aan bod komen. Het beschrijft niet HOE de vraag klinkt — dat doet het
 * hot-path model op basis van de hint uit de feitcatalogus.
 */
export interface IntakeTemplate {
  readonly key: string;
  readonly practiceArea: 'employment';
  readonly version: number;
  /** Fact-sleutels die minimaal `confirmed` of `unknown` moeten zijn voor afronding. */
  readonly requiredFactKeys: readonly string[];
  /** Drempel voor `CompletenessScorer` waarboven de intake afgerond mag worden. */
  readonly completionThreshold: number;
  /** Harde bovengrens aan beurten; daarna alleen nog must-haves. */
  readonly maxTurns: number;
  /** Na dit aantal beurten wordt de vermoeidheidsaftrek actief. */
  readonly fatigueAfterTurns: number;
}

export const IntakeTemplateSchema = z.object({
  key: z.string(),
  practiceArea: PracticeAreaSchema,
  version: z.number().int().positive(),
  requiredFactKeys: z.array(z.string()),
  completionThreshold: z.number().min(0).max(1),
  maxTurns: z.number().int().positive(),
  fatigueAfterTurns: z.number().int().positive(),
});

/**
 * Urgentieregels zijn de bron van waarheid (§6). Ze zijn deterministisch: gegeven
 * dezelfde feiten volgt hetzelfde niveau. AI mag alleen aanvullend signaleren.
 */
export interface IntakeRule {
  readonly key: string;
  readonly level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly label: { readonly nl: string; readonly en: string };
  /** Wanneer slaat deze regel aan? */
  readonly when: FactCondition | DeadlineCondition | ElapsedCondition;
  /** Extra gewicht dat de planner geeft aan feiten die deze regel kunnen bevestigen. */
  readonly plannerBoost: number;
}

/** Termijngebonden regels rekenen met dagen tot een datum-feit. */
export type DeadlineCondition = {
  readonly kind: 'deadlineWithin';
  readonly key: string;
  readonly days: number;
};

/** Regels waarvoor een datum in het verleden juist het signaal is. */
export type ElapsedCondition = {
  readonly kind: 'elapsedSince';
  readonly key: string;
  readonly days: number;
};

export const IntakeRuleSchema = z.object({
  key: z.string(),
  level: UrgencyLevelSchema,
  label: z.object({ nl: z.string(), en: z.string() }),
  plannerBoost: z.number(),
});
