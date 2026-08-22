import { z } from 'zod';
import type { Language, PracticeArea, ValueType } from '../enums';

/**
 * De feitcatalogus staat in code, niet in de database (§4). Een nieuwe intakevraag
 * kost daardoor een deploy, geen migratie — en de planner kan er synchroon overheen
 * scoren zonder query.
 */

/** Voorwaarde waaronder een feit überhaupt relevant is. Deterministisch evalueerbaar. */
export type FactCondition =
  | { kind: 'always' }
  | { kind: 'factEquals'; key: string; value: unknown }
  | { kind: 'factIn'; key: string; values: readonly unknown[] }
  | { kind: 'factKnown'; key: string }
  | { kind: 'anyOf'; conditions: readonly FactCondition[] }
  | { kind: 'allOf'; conditions: readonly FactCondition[] }
  | { kind: 'not'; condition: FactCondition };

export interface LocalisedText {
  readonly nl: string;
  readonly en: string;
}

export interface FactDefinition {
  /** Stabiele sleutel; komt letterlijk in `case_facts.key`. Nooit hernoemen zonder migratie. */
  readonly key: string;
  readonly category: string;
  readonly valueType: ValueType;
  /** Basisprioriteit voor de QuestionPlanner (§6). Hoger = eerder vragen. */
  readonly priority: number;
  /** Must-have voor `CompletenessScorer`. Optionele feiten tellen mee, maar blokkeren niet. */
  readonly required: boolean;
  /** Extra gewicht als dit feit bepaalt of het kantoor de zaak aanneemt. */
  readonly criteriaWeight?: number;
  /** Draagt dit feit bij aan urgentiebepaling? Dan trekt de planner het naar voren. */
  readonly urgencyRelevant?: boolean;
  readonly label: LocalisedText;
  /**
   * Formuleringshints voor het hot-path model. Het model kiest en formuleert zelf —
   * dit zijn geen letterlijke scripts, anders klinkt de assistent als een formulier.
   */
  readonly hint: LocalisedText;
  readonly enumValues?: readonly string[];
  /** Wanneer is dit feit relevant? Default: altijd. */
  readonly relevantWhen?: FactCondition;
  /** Validator voor de waarde die uiteindelijk in `case_facts.value` landt. */
  readonly validator: z.ZodTypeAny;
  /** Bijzondere persoonsgegevens (art. 9 AVG) — o.a. gezondheid. Extra behandeling in logs/retentie. */
  readonly specialCategory?: boolean;
}

export interface FactCatalog {
  readonly practiceArea: PracticeArea;
  readonly categories: readonly FactCategoryDefinition[];
  readonly facts: readonly FactDefinition[];
}

export interface FactCategoryDefinition {
  readonly key: string;
  readonly label: LocalisedText;
  /** Volgorde binnen de intake; de planner mag hiervan afwijken op urgentie. */
  readonly order: number;
  readonly relevantWhen?: FactCondition;
}

/** Gemaksconstructors zodat de catalogus leesbaar blijft. */
export const always: FactCondition = { kind: 'always' };
export const factEquals = (key: string, value: unknown): FactCondition => ({
  kind: 'factEquals',
  key,
  value,
});
export const factIn = (key: string, values: readonly unknown[]): FactCondition => ({
  kind: 'factIn',
  key,
  values,
});
export const factKnown = (key: string): FactCondition => ({ kind: 'factKnown', key });
export const anyOf = (...conditions: FactCondition[]): FactCondition => ({
  kind: 'anyOf',
  conditions,
});
export const allOf = (...conditions: FactCondition[]): FactCondition => ({
  kind: 'allOf',
  conditions,
});
export const not = (condition: FactCondition): FactCondition => ({ kind: 'not', condition });

/**
 * ISO-datum als string. Nederlandse datums ("14 augustus", "vrijdag") worden in de
 * extractielaag genormaliseerd; hier komt alleen het genormaliseerde resultaat binnen.
 */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'verwacht formaat YYYY-MM-DD');

export const MoneySchema = z.number().nonnegative().finite();

export function buildFactIndex(catalog: FactCatalog): ReadonlyMap<string, FactDefinition> {
  const index = new Map<string, FactDefinition>();
  for (const fact of catalog.facts) {
    if (index.has(fact.key)) {
      throw new Error(`Dubbele fact key in catalogus: ${fact.key}`);
    }
    index.set(fact.key, fact);
  }
  return index;
}

export function localise(text: LocalisedText, language: Language): string {
  return text[language];
}
