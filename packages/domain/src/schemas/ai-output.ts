import { z } from 'zod';
import { FactSourceSchema, FactStatusSchema, UrgencyLevelSchema, ValueTypeSchema } from '../enums';

/**
 * Alle cold-path-output. AI-output is per definitie onbetrouwbaar (§2.7): elk schema
 * hieronder is gesloten (`.strict()`), elk feit draagt confidence en herkomst, en
 * `unknown` blijft `unknown`. Nooit invullen op basis van aannames.
 */

// ------------------------------------------------------------ fact extraction

export const ExtractedFactSchema = z
  .object({
    key: z.string().min(1).max(120),
    value: z.unknown(),
    valueType: ValueTypeSchema,
    status: FactStatusSchema,
    confidence: z.number().min(0).max(1),
    source: FactSourceSchema,
    /**
     * Verplicht. Het model moet aanwijzen wáár in het transcript of document dit
     * vandaan komt; zonder verwijzing wordt het feit geweigerd, niet opgeslagen.
     */
    sourceRef: z.string().min(1),
    /** Letterlijk citaat uit de bron. Basis voor de hallucinatiecheck. */
    evidenceQuote: z.string().min(1).max(1000),
  })
  .strict();
export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;

/**
 * Wat het MODEL levert — bewust minder dan wat wij opslaan.
 *
 * `ExtractedFactSchema` hierboven eist acht velden, waarvan er drie mechanisch zijn:
 * `valueType` staat in de feitcatalogus, `source` is bij transcriptextractie per definitie
 * `client_statement`, en `sourceRef` weet de engine zelf. Die alsnog aan het model vragen
 * vergroot alleen het aantal manieren waarop het schema kan mislukken — en dat is precies
 * wat er live gebeurde: het model vond de feiten correct, noemde ze `field` en `quote`, en
 * alles werd geweigerd.
 *
 * Vraag een model alleen wat het weet en jij niet.
 */
export const ExtractedFactDraftSchema = z
  .object({
    key: z.string().min(1).max(120),
    value: z.unknown(),
    status: FactStatusSchema,
    confidence: z.number().min(0).max(1),
    /** Letterlijk citaat uit de bron. Basis voor de hallucinatiecheck. */
    evidenceQuote: z.string().min(1).max(1000),
  })
  .strict();
export type ExtractedFactDraft = z.infer<typeof ExtractedFactDraftSchema>;

export const FactExtractionModelResultSchema = z
  .object({
    facts: z.array(ExtractedFactDraftSchema).max(50),
  })
  .strict();
export type FactExtractionModelResult = z.infer<typeof FactExtractionModelResultSchema>;

export const FactExtractionResultSchema = z
  .object({
    facts: z.array(ExtractedFactSchema).max(50),
    /** Sleutels die het model expliciet als niet-vastgesteld markeert. */
    explicitlyUnknown: z.array(z.string()).max(50).default([]),
  })
  .strict();
export type FactExtractionResult = z.infer<typeof FactExtractionResultSchema>;

// ------------------------------------------------------------------- urgency

/**
 * Het model mag alleen signaleren. De rule engine is de bron van waarheid (§6).
 * Een AI-signaal zonder overeenkomstige regelmatch verhoogt de urgentie niet.
 */
export const UrgencySignalSchema = z
  .object({
    ruleKey: z.string().min(1).max(120),
    level: UrgencyLevelSchema,
    rationale: z.string().min(1).max(500),
    evidenceQuote: z.string().min(1).max(1000),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type UrgencySignal = z.infer<typeof UrgencySignalSchema>;

export const UrgencyDetectionResultSchema = z
  .object({ signals: z.array(UrgencySignalSchema).max(20) })
  .strict();
export type UrgencyDetectionResult = z.infer<typeof UrgencyDetectionResultSchema>;

export const RiskFlagSchema = z.object({
  ruleKey: z.string(),
  level: UrgencyLevelSchema,
  /** Presentatie is altijd conditioneel — nooit een vaststelling. */
  label: z.string(),
  detectedBy: z.enum(['rule', 'rule+ai']),
  sourceRef: z.string().nullable(),
  createdAt: z.string().datetime().optional(),
});
export type RiskFlag = z.infer<typeof RiskFlagSchema>;

/** De enige toegestane presentatievorm van urgentie in de UI. */
export const URGENCY_DISCLAIMER_NL = 'Mogelijk urgente termijn — menselijke beoordeling vereist.';
export const URGENCY_DISCLAIMER_EN = 'Possibly urgent deadline — human review required.';

// --------------------------------------------------------- document analysis

export const DocumentAnalysisSchema = z
  .object({
    documentType: z.string().max(120),
    documentDate: z.string().nullable(),
    parties: z.array(z.string().max(200)).max(20),
    importantDates: z
      .array(z.object({ date: z.string(), description: z.string().max(300) }).strict())
      .max(30),
    shortSummary: z.string().max(2000),
    potentialDeadlines: z
      .array(
        z
          .object({
            date: z.string(),
            description: z.string().max(300),
            confidence: z.number().min(0).max(1),
          })
          .strict(),
      )
      .max(20),
    notableClauses: z.array(z.string().max(500)).max(20),
    confidence: z.number().min(0).max(1),
    /**
     * Het model meldt hier of het instructie-achtige tekst in het document aantrof.
     * Een `true` blokkeert automatische urgentieverhoging en vraagt om menselijke blik.
     */
    containsInstructionLikeText: z.boolean().default(false),
  })
  .strict();
export type DocumentAnalysis = z.infer<typeof DocumentAnalysisSchema>;

// ----------------------------------------------------------------- summary

export const SummarySectionSchema = z
  .object({
    key: z.enum([
      'case_summary',
      'practice_area',
      'core_problem',
      'timeline',
      'key_facts',
      'client_goal',
      'documents',
      'missing_information',
      'possible_urgency',
      'firm_criteria',
      'disclaimer',
    ]),
    body: z.string(),
    /** Elke bewering verwijst naar een case_fact key of een turn-id. Leeg = alleen vaste tekst. */
    citations: z.array(z.string()).default([]),
  })
  .strict();
export type SummarySection = z.infer<typeof SummarySectionSchema>;

export const IntakeSummarySchema = z
  .object({
    sections: z.array(SummarySectionSchema),
    /** Sleutels die letterlijk als "Niet vastgesteld" moeten worden getoond. */
    notEstablished: z.array(z.string()).default([]),
  })
  .strict();
export type IntakeSummary = z.infer<typeof IntakeSummarySchema>;

export const NOT_ESTABLISHED_NL = 'Niet vastgesteld';
export const NOT_ESTABLISHED_EN = 'Not established';

export const SUMMARY_DISCLAIMER_NL =
  'Dit is een door AI gegenereerde intakesamenvatting. Zij bevat geen juridisch advies en ' +
  'vereist beoordeling door een jurist. Onbekende gegevens zijn als "Niet vastgesteld" gemarkeerd.';
export const SUMMARY_DISCLAIMER_EN =
  'This is an AI-generated intake summary. It contains no legal advice and requires review by a ' +
  'qualified lawyer. Unknown data is marked "Not established".';

// ------------------------------------------------------------- validatiehulp

export interface Validated<T> {
  readonly data: T;
  readonly schemaValid: boolean;
  readonly repairAttempts: number;
  readonly raw?: string;
}

/**
 * Weigert feiten die niet naar een citaat in de bron te herleiden zijn.
 * Dit is de hallucinatiecheck uit §11: een gehallucineerd feit dat niet in het
 * transcript staat, wordt geweigerd in plaats van opgeslagen.
 */
export function rejectUngroundedFacts(
  facts: readonly ExtractedFact[],
  sourceText: string,
): { accepted: ExtractedFact[]; rejected: { fact: ExtractedFact; reason: string }[] } {
  const haystack = normaliseForMatching(sourceText);
  const accepted: ExtractedFact[] = [];
  const rejected: { fact: ExtractedFact; reason: string }[] = [];

  for (const fact of facts) {
    if (fact.status === 'unknown') {
      accepted.push(fact);
      continue;
    }
    const needle = normaliseForMatching(fact.evidenceQuote);
    if (needle.length < 3) {
      rejected.push({ fact, reason: 'evidenceQuote te kort om te verifiëren' });
      continue;
    }
    if (!haystack.includes(needle)) {
      rejected.push({ fact, reason: 'evidenceQuote komt niet voor in de bron' });
      continue;
    }
    accepted.push(fact);
  }
  return { accepted, rejected };
}

function normaliseForMatching(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      // combining diacritical marks — zodat "oke" en "oké" hetzelfde matchen
      .replace(/[̀-ͯ]/gu, '')
      .replace(/\s+/gu, ' ')
      .trim()
  );
}
