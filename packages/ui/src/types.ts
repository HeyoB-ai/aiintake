import type { CaseFact, RiskFlag, UrgencyLevel } from '@intake/domain';

/**
 * Types voor de presentatielaag.
 *
 * Wat het domein al kent — `CaseFact`, `RiskFlag`, `UrgencyLevel` — wordt hier
 * geïmporteerd en niet nagebouwd. Het prototype had een eigen `DossierState` met een
 * platte lijst hardgecodeerde feitsleutels en drie urgentieniveaus; wij hebben er vier
 * (LOW, MEDIUM, HIGH, CRITICAL) en de feiten komen uit het template van het rechtsgebied.
 * Een tweede definitie zou stilzwijgend uit de pas gaan lopen bij de eerste wijziging.
 */

/** De HUD-regel per beurt, zoals `formatHudLine` hem samenstelt. */
export interface LatencyStats {
  readonly eot: number;
  readonly llm: number;
  readonly tts: number;
  readonly frame: number;
  readonly totaal: number;
  /** Weggesneden aanloopstilte in ms. */
  readonly aanloop: number;
}

export type Speaker = 'ASSISTENT' | 'U' | 'SYSTEEM';

export interface ConversationMessage {
  readonly id: string;
  readonly speaker: Speaker;
  readonly text: string;
  /** Al opgemaakt als HH:MM:SS — de component rekent niet met tijd. */
  readonly timestamp: string;
  /** Alleen zichtbaar als de HUD aanstaat; nooit voor de cliënt. */
  readonly latency?: LatencyStats;
}

/**
 * De fasen van het opzetten, zoals de liveserver ze meldt.
 *
 * Dit spiegelt de fasebalk uit apps/agent/live: sessie, verbonden, eerste frame. Het
 * prototype had deze drie badges hardgecodeerd op groen, wat betekent dat het scherm
 * "verbonden" meldt terwijl er niets staat.
 */
export type FaseStand = 'wachten' | 'bezig' | 'klaar' | 'fout';

export interface SessieFasen {
  readonly sessie: FaseStand;
  readonly verbonden: FaseStand;
  readonly eersteFrame: FaseStand;
  /** Zichtbare uitleg bij `fout`. */
  readonly fout?: string;
}

export const DOCUMENT_CATEGORIES = [
  'Arbeidscontract',
  'Ontslagbrief',
  'Loonstrook',
  'Medisch / Ziekte',
  'UWV Dossier',
  'Correspondentie',
  'Bewijsstuk',
  'Overig',
] as const;

export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

/**
 * Eén geüpload bewijsstuk.
 *
 * `status` is betekenisvol en niet decoratief: `processing` betekent dat de analyse nog
 * loopt. De component mag geen feiten tonen zolang die status geldt — in het prototype
 * werd elk bestand meteen als `analyzed` gemarkeerd met verzonnen feiten erbij.
 */
export interface DocumentItem {
  readonly id: string;
  readonly name: string;
  readonly type: 'pdf' | 'image' | 'doc' | 'text';
  readonly category: DocumentCategory;
  /** Al opgemaakt, bijvoorbeeld "318 KB". */
  readonly size: string;
  readonly uploadedAt: string;
  readonly status: 'processing' | 'analyzed' | 'failed';
  /** Leeg zolang de analyse loopt. */
  readonly summary: string;
  /**
   * Wat de extractie uit dít document haalde.
   *
   * Elk item draagt een `sourceRef` naar de plek in het document. Zonder herkomst hoort
   * een feit niet getoond te worden; dat is dezelfde regel als `TraceableCaseFactSchema`
   * in het domein.
   */
  readonly extractedFacts: readonly DocumentFact[];
  readonly previewUrl?: string;
  readonly textContent?: string;
  readonly failureReason?: string;
}

export interface DocumentFact {
  readonly label: string;
  readonly value: string;
  /** Waar in het document dit vandaan komt. Verplicht: geen bewering zonder bron. */
  readonly sourceRef: string;
  /** Optioneel etiket, bijvoorbeeld het urgentieniveau dat de regel eraan gaf. */
  readonly level?: UrgencyLevel;
}

/**
 * Wat het dossierpaneel toont. **Alleen voor het advocatendashboard.**
 *
 * Zie de kop van DossierSidebar: urgentie en volledigheid horen niet in het cliëntscherm.
 */
export interface DossierState {
  /** 0..1, zoals `CompletenessScorer` hem teruggeeft. */
  readonly completeness: number | null;
  readonly facts: readonly CaseFact[];
  readonly riskFlags: readonly RiskFlag[];
  /** Feiten die de grondingscontrole tegenhield, met reden. */
  readonly rejected: readonly { readonly key: string; readonly reason: string }[];
}
