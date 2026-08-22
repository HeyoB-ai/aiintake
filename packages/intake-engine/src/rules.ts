import type { CaseFactMap, FactCondition, IntakeRule } from '@intake/domain';
import { daysSince, daysUntil, evaluate } from './conditions';

/**
 * Urgentieregels evalueren.
 *
 * Deterministisch en zonder model. Dat is niet uit wantrouwen tegen het model maar uit
 * verklaarbaarheid: een advocaat moet kunnen navragen wélke regel een CRITICAL
 * veroorzaakte, en bij een vervaltermijn is "het model vond van wel" geen antwoord.
 *
 * Het model mag urgentie wél *signaleren* (UrgencyDetectionResult), maar dat is een
 * aanvulling die naast het regeloordeel komt te staan, nooit in de plaats ervan.
 */

const RANG: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

export interface FiredRule {
  readonly ruleKey: string;
  readonly level: string;
  readonly label: string;
}

/** Slaat deze regel aan met de feiten die er nu zijn? */
export function ruleFires(rule: IntakeRule, facts: CaseFactMap, now: Date): boolean {
  const w = rule.when as { kind?: string; key?: string; days?: number };

  if (w.kind === 'deadlineWithin') {
    const dagen = daysUntil(facts[w.key!]?.value, now);
    // `>= 0`: een deadline die vandaag verloopt telt mee, een verstreken deadline niet.
    // Voor het verstreken geval bestaat `elapsedSince`, met een eigen regel en een eigen
    // label — het verschil tussen "je hebt nog drie dagen" en "je bent te laat" is te
    // groot om onder één signaal te vangen.
    return dagen !== null && dagen >= 0 && dagen <= (w.days ?? 0);
  }

  if (w.kind === 'elapsedSince') {
    const dagen = daysSince(facts[w.key!]?.value, now);
    return dagen !== null && dagen >= (w.days ?? 0);
  }

  return evaluate(rule.when as FactCondition, facts);
}

/**
 * Kan deze regel nog kant kiezen?
 *
 * Onbeslisbaar betekent: hij is nog niet afgegaan, en er ontbreekt minstens één feit
 * waarvan hij afhangt. Precies die regels moeten hun feiten naar voren trekken in de
 * planner — anders komt de deadline pas in beurt dertig aan het licht, en dan is het
 * signaal er wel maar de tijd niet meer.
 */
export function ruleIsUndecidable(rule: IntakeRule, facts: CaseFactMap, now: Date): boolean {
  if (ruleFires(rule, facts, now)) return false;
  return ontbrekendeSleutels(rule.when, facts).length > 0;
}

function ontbrekendeSleutels(when: unknown, facts: CaseFactMap): string[] {
  const uit: string[] = [];
  const loop = (c: unknown): void => {
    if (!c || typeof c !== 'object') return;
    const k = c as { key?: string; conditions?: unknown[]; condition?: unknown };
    if (k.key) {
      const fact = facts[k.key];
      // `unknown` telt hier als beantwoord: de cliënt heeft gezegd het niet te weten,
      // dus de regel gaat er niet alsnog van komen en het feit hoeft niet omhoog.
      const beslist =
        fact &&
        (fact.status === 'confirmed' || fact.status === 'inferred' || fact.status === 'unknown');
      if (!beslist) uit.push(k.key);
    }
    if (k.conditions) for (const sub of k.conditions) loop(sub);
    if (k.condition) loop(k.condition);
  };
  loop(when);
  return uit;
}

/** Alle regels die afgaan, hoogste niveau eerst. */
export function evaluateRules(
  rules: readonly IntakeRule[],
  facts: CaseFactMap,
  now: Date,
  language: 'nl' | 'en' = 'nl',
): readonly FiredRule[] {
  return rules
    .filter((r) => ruleFires(r, facts, now))
    .map((r) => ({ ruleKey: r.key, level: r.level, label: r.label[language] }))
    .sort((a, b) => (RANG[b.level] ?? 0) - (RANG[a.level] ?? 0));
}

/** Het hoogste niveau dat afgaat; `LOW` als er niets afgaat. */
export function urgencyLevel(
  rules: readonly IntakeRule[],
  facts: CaseFactMap,
  now: Date,
): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  let hoogste: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' = 'LOW';
  for (const rule of rules) {
    if (!ruleFires(rule, facts, now)) continue;
    if ((RANG[rule.level] ?? 0) > (RANG[hoogste] ?? 0)) hoogste = rule.level;
  }
  return hoogste;
}
