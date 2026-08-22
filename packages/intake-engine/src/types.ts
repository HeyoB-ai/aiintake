import type {
  CaseFactMap,
  DocumentAnalysis,
  IntakeRule,
  IntakeTemplate,
  Language,
  OrgConfig,
  Turn,
  VisualSignals,
} from '@intake/domain';

/**
 * Het contract van de IntakeConversationEngine.
 *
 * Input is toestand, output is een beslissing. De engine kent geen HTTP, geen WebRTC
 * en geen avatarleverancier — daardoor werkt exact dezelfde intake-intelligentie in de
 * videomodus én in de chat-fallback, en is hij te testen zonder één netwerkcall.
 *
 * De boundary-lintregel in .dependency-cruiser.cjs handhaaft dat: dit pakket mag
 * alleen @intake/domain en @intake/prompts importeren, en geen node builtins.
 */

export interface EngineInput {
  readonly organization: OrgConfig;
  readonly practiceArea: 'employment';
  readonly template: IntakeTemplate;
  readonly rules: readonly IntakeRule[];
  readonly facts: CaseFactMap;
  /** Alleen wat DAADWERKELIJK is uitgesproken of gelezen. Zie truncateToSpoken(). */
  readonly history: readonly Turn[];
  readonly documents: readonly DocumentSummary[];
  readonly pendingLawyerRequests: readonly string[];
  readonly language: Language;
  /**
   * Uitsluitend voor pacing. Deze signalen bereiken nooit FactExtractor of
   * SummaryGenerator — die functies accepteren dit veld simpelweg niet als input.
   */
  readonly signals?: VisualSignals;
  readonly mode: 'realtime' | 'chat';
  /** Wat de cliënt zojuist zei; leeg bij de openingsbeurt. */
  readonly lastClientUtterance?: string;
  /**
   * Bij herstel na een barge-in: het deel van de vorige assistentbeurt dat de cliënt
   * wél heeft gehoord. De engine herformuleert korter in plaats van letterlijk te
   * herhalen — woordelijk opnieuw beginnen is het duidelijkste "ik ben een machine"-
   * signaal dat er is.
   */
  readonly interruptedPrefix?: string;
}

export interface DocumentSummary {
  readonly id: string;
  readonly filename: string;
  readonly analysis: DocumentAnalysis | null;
}

export interface EngineDecision {
  readonly intent: 'ask' | 'acknowledge' | 'clarify' | 'close' | 'handoff';
  /**
   * Gestreamd, per zin. De engine wacht nooit op de complete respons: je kunt geen
   * JSON naar TTS streamen, dus het hot path levert platte tekst die per zinsafsluiting
   * geflusht wordt.
   */
  readonly speak: AsyncIterable<string>;
  /** Wat de planner wilde weten. Gaat mee naar messages.planned_question_keys. */
  readonly plannedQuestionKeys: readonly string[];
  readonly pacing: Pacing;
}

export interface Pacing {
  /**
   * Eén korte overbruggingszin ("Even kijken —") vóór een zware beurt, met een strikt
   * maximum van één per drie beurten. Vaker en het wordt een tic.
   */
  readonly allowFiller: boolean;
  readonly maxSentences: number;
}

/** Kandidaatvraag zoals de planner hem aan het hot-path model aanbiedt. */
export interface QuestionCandidate {
  readonly factKey: string;
  readonly score: number;
  /** Formuleringshint uit de feitcatalogus. Geen script — het model formuleert zelf. */
  readonly hint: string;
  readonly label: string;
  readonly reasons: readonly string[];
}

export interface IntakeConversationEngine {
  /** Hot path. Blokkeert spraak; budget ~400 ms tot eerste token. */
  respond(input: EngineInput): Promise<EngineDecision>;
  /**
   * Cold path. Draait asynchroon na elke beurt en blokkeert niets: fact extraction,
   * urgency, volledigheidsscore. Eén beurt vertraging in feitenkennis is acceptabel —
   * de planner werkt met de feiten van beurt N-1 en het hot-path model ziet het ruwe
   * transcript, dus het gesprek voelt niet vertraagd aan.
   */
  observe(input: EngineInput): Promise<ObservationResult>;
}

export interface ObservationResult {
  readonly factUpdates: readonly FactUpdate[];
  readonly riskFlags: readonly { ruleKey: string; level: string; label: string }[];
  readonly completeness: number;
  readonly missingRequiredKeys: readonly string[];
}

export interface FactUpdate {
  readonly key: string;
  readonly value: unknown;
  readonly valueType: 'string' | 'number' | 'date' | 'boolean' | 'enum';
  readonly status: 'confirmed' | 'inferred' | 'unknown' | 'contradicted';
  readonly confidence: number;
  readonly source: 'client_statement' | 'document' | 'lawyer_input';
  readonly sourceRef: string;
  readonly evidenceQuote: string;
}
