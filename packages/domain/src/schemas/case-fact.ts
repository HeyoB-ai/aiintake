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
  /*
   * `client_form` hoeft geen `sourceRef`, en dat is geen versoepeling.
   *
   * Een `sourceRef` wijst naar het bericht waarin het is gezegd, zodat een advocaat de
   * bewering kan terugvinden in het transcript. Een veld dat de cliënt zelf op het
   * toestemmingsscherm heeft ingetypt, staat niet in het transcript — er ís geen bericht om
   * naar te wijzen, en er een verzinnen zou de herleidbaarheid juist ondermijnen.
   *
   * De herkomst is er wél: `source = 'client_form'` zegt precies waar het vandaan komt, en dat
   * is voor dit geval de hele herleiding.
   */
  (fact) => fact.status === 'unknown' || fact.source === 'client_form' || fact.sourceRef !== null,
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
