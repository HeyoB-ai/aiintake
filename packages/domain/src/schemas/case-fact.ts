import { z } from 'zod';
import { FactSourceSchema, FactStatusSchema, ValueTypeSchema } from '../enums';

/**
 * Eén vastgesteld (of expliciet niet-vastgesteld) feit over de zaak.
 * Spiegelt `public.case_facts`.
 */
export const CaseFactSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.unknown(),
  valueType: ValueTypeSchema,
  status: FactStatusSchema,
  /** 0..1. Bij `status = 'unknown'` betekenisloos maar wel verplicht ingevuld (0). */
  confidence: z.number().min(0).max(1),
  source: FactSourceSchema,
  /** message_id of document_id — waar komt dit vandaan? Verplicht bij confirmed/inferred. */
  sourceRef: z.string().nullable(),
  llmCallId: z.string().uuid().nullable(),
  updatedAt: z.string().datetime().optional(),
});
export type CaseFact = z.infer<typeof CaseFactSchema>;

/**
 * Een feit zonder herkomst mag niet als vastgesteld gelden. Dit is de codepad-variant
 * van de regel uit §10: elke bewering in de samenvatting is herleidbaar.
 */
export const TraceableCaseFactSchema = CaseFactSchema.refine(
  (fact) => fact.status === 'unknown' || fact.sourceRef !== null,
  {
    message: 'Een confirmed/inferred/contradicted feit vereist een sourceRef',
    path: ['sourceRef'],
  },
);

export type CaseFactMap = Readonly<Record<string, CaseFact>>;

export function isKnown(fact: CaseFact | undefined): boolean {
  return fact !== undefined && fact.status !== 'unknown';
}

export function isConfirmed(fact: CaseFact | undefined): boolean {
  return fact !== undefined && fact.status === 'confirmed';
}
