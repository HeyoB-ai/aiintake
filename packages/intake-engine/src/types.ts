import type {
  Lading,
  WanhoopSoort,
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
  /**
   * De naam die de cliënt op het toestemmingsscherm heeft ingevuld.
   *
   * Geen `case_fact`: er is geen citaat dat hem staaft en er valt niet op door te vragen.
   * Hij komt uit `intakes.client_name` en is er dus al vóór de eerste beurt — precies wat
   * nodig is, want de opening is de beurt waarin hij gebruikt wordt.
   *
   * `null` betekent: niet ingevuld. Dan groet de assistent zonder naam en verzint er geen.
   */
  readonly clientName?: string | null;
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
  /**
   * De klok, geïnjecteerd en niet gelezen.
   *
   * Termijnregels rekenen in dagen tot een datum. Zou de engine zelf `new Date()`
   * aanroepen, dan is geen enkele test over een naderende vervaltermijn reproduceerbaar
   * en verandert het gedrag stilletjes met de dag waarop je hem draait.
   */
  readonly now: Date;
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
  /**
   * Het oordeel over de lading van de laatste cliëntuitspraak, als er een gevraagd is.
   *
   * Een belofte en geen waarde: hij draait náást de generatie en is bewust niet awaited
   * door de engine. De aanroeper beslist of hij er nog op wacht — en het antwoord daarop
   * hoort "nee" te zijn zodra het model begint te praten. Zie de toelichting bij `respond`.
   */
  readonly lading?: Promise<LadingOordeel | null>;
  /**
   * Dit is de eerste beurt van een hérvatte sessie, niet van een nieuwe intake.
   *
   * De aanroeper zet er een vaste zin voor. Waarom die niet uit het model komt, staat in
   * @intake/domain/hervatting.ts: het model krijgt de geschiedenis als dialoog mee, en dan
   * is "u vertelde dat u ontslagen bent" één generatie ver — een bewering over een dossier
   * dat op dat moment nog leeg is.
   */
  readonly isResuming?: boolean;
}

/** Wat het ladingmodel teruggeeft. Drie velden, verder niets. */
export interface LadingOordeel {
  readonly lading: Lading;
  /** Nood bij de cliënt zelf, en van welke soort. Bepaalt de verwijzing. */
  readonly wanhoop: WanhoopSoort;
  /** Een gevoel dat de cliënt zélf benoemde, letterlijk. Nooit afgeleid. */
  readonly geuitGevoel: string | null;
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
  /**
   * Voortgang per onderwerp: hoeveel categorieën aangeraakt van hoeveel relevante.
   *
   * Bestaat voor het gespreksscherm van de cliënt. Die weet nu niet of dit vijf of
   * vijfentwintig minuten duurt, en stilte daarover is het slechtste antwoord.
   *
   * Bewust dit en niet `completeness`: dat is een gewogen score met een afkapping voor
   * openstaande must-haves, en die als percentage tonen zou een precisie suggereren die er
   * niet is. Een teller van onderwerpen is grof en klopt.
   */
  readonly topicsTouched: number;
  readonly topicsRelevant: number;
  /**
   * Feiten die de hallucinatiecheck heeft geweigerd, met de reden.
   *
   * Dit veld bestaat omdat een controle die stilzwijgend weggooit niet te onderscheiden
   * is van een controle die niets doet. Als het model structureel citaten verzint die
   * niet in het transcript staan, moet dat een zichtbaar getal zijn en geen stilte.
   */
  readonly rejectedFacts?: readonly RejectedFact[];
  /**
   * De extractie leverde niets bruikbaars op, met de reden.
   *
   * Bestaat omdat het alternatief een lege lijst is, en die is niet te onderscheiden van
   * "er viel niets te vinden". Live betekende dat vier beurten lang dat de assistent
   * vroeg naar wat de cliënt net had verteld, zonder dat er ergens iets rood werd.
   */
  readonly extractionError?: string;
}

export interface RejectedFact {
  readonly key: string;
  readonly reason: string;
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
