import type { CaseFactMap, FactCondition } from '@intake/domain';

/**
 * Evaluatie van conditionele relevantie.
 *
 * Deterministisch en puur: gegeven dezelfde feiten volgt dezelfde uitkomst. Dat is de
 * reden dat dit hier staat en niet in een prompt — "gegeven feiten X moet vraag Y
 * bovenaan staan" moet een test zijn, geen hoop.
 */

export function evaluate(condition: FactCondition | undefined, facts: CaseFactMap): boolean {
  if (!condition) return true;

  switch (condition.kind) {
    case 'always':
      return true;

    case 'factKnown': {
      const fact = facts[condition.key];
      return fact !== undefined && fact.status !== 'unknown';
    }

    case 'factEquals': {
      const fact = facts[condition.key];
      // Een feit dat expliciet onbekend is, bevestigt geen enkele voorwaarde.
      if (!fact || fact.status === 'unknown') return false;
      return deepEquals(fact.value, condition.value);
    }

    case 'factIn': {
      const fact = facts[condition.key];
      if (!fact || fact.status === 'unknown') return false;
      return condition.values.some((v) => deepEquals(fact.value, v));
    }

    case 'anyOf':
      return condition.conditions.some((c) => evaluate(c, facts));

    case 'allOf':
      return condition.conditions.every((c) => evaluate(c, facts));

    case 'not':
      return !evaluate(condition.condition, facts);
  }
}

/**
 * Waardevergelijking. `value` komt uit jsonb en kan dus number, string, boolean of
 * null zijn; datums zijn genormaliseerde ISO-strings.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * Dagen tot een datumfeit. Negatief als de datum in het verleden ligt.
 *
 * `now` wordt expliciet meegegeven en niet uit `Date.now()` gelezen: urgentieregels
 * moeten reproduceerbaar te testen zijn, en een regel die vandaag afgaat en morgen
 * niet is geen regel maar een verrassing.
 */
export function daysUntil(isoDate: unknown, now: Date): number | null {
  if (typeof isoDate !== 'string') return null;
  const target = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(target)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

export function daysSince(isoDate: unknown, now: Date): number | null {
  const until = daysUntil(isoDate, now);
  return until === null ? null : -until;
}
