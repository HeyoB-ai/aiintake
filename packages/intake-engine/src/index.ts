/**
 * De vendor-onafhankelijke intake-intelligentie.
 *
 * Fase 0 leverde het contract en de deterministische bouwstenen; Fase 2 vult het in met
 * de QuestionPlanner, de urgentieregels, de volledigheidsscore en de twee LLM-sporen.
 * De cold-path diensten voor samenvatting en documenten komen in Fase 3.
 *
 * De grens blijft bewaakt door de boundary-regel: dit pakket mag alleen @intake/domain
 * en @intake/prompts importeren, en geen node builtins. Breekt die, dan werkt de
 * intake-intelligentie niet langer identiek in videomodus en chat-fallback.
 */
export * from './completeness';
export * from './conditions';
export * from './engine';
export * from './planner';
export * from './rules';
export * from './types';
