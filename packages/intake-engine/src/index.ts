/**
 * De vendor-onafhankelijke intake-intelligentie.
 *
 * Fase 0 levert hier het contract en de deterministische bouwstenen. De
 * QuestionPlanner, het arbeidsrecht-template en de twee LLM-sporen komen in Fase 2;
 * de cold-path-diensten in Fase 3. De grens blijft ondertussen bewaakt door de
 * boundary-lintregel: breekt die, dan is de architectuur gebroken.
 */
export * from './conditions';
export * from './types';
