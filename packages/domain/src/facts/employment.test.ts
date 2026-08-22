import { describe, expect, it } from 'vitest';
import { buildFactIndex, type FactCondition } from './catalog';
import { EMPLOYMENT_CATALOG, EMPLOYMENT_CATEGORIES, EMPLOYMENT_FACTS } from './employment';

/**
 * De feitcatalogus is de ruggengraat van de intake: de planner scoort erover, de
 * extractie schrijft ernaartoe, de samenvatting leest eruit. Een sleutel die naar
 * niets verwijst of twee keer bestaat, valt pas op als het gesprek al loopt.
 */

const index = buildFactIndex(EMPLOYMENT_CATALOG);

function referencedKeys(condition: FactCondition): string[] {
  switch (condition.kind) {
    case 'always':
      return [];
    case 'factEquals':
    case 'factIn':
    case 'factKnown':
      return [condition.key];
    case 'anyOf':
    case 'allOf':
      return condition.conditions.flatMap(referencedKeys);
    case 'not':
      return referencedKeys(condition.condition);
  }
}

describe('arbeidsrecht-feitcatalogus', () => {
  it('heeft 17 categorieën', () => {
    expect(EMPLOYMENT_CATEGORIES).toHaveLength(17);
  });

  it('heeft unieke categoriesleutels en een sluitende volgorde', () => {
    const keys = EMPLOYMENT_CATEGORIES.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...EMPLOYMENT_CATEGORIES].map((c) => c.order).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 17 }, (_, i) => i + 1),
    );
  });

  it('heeft geen dubbele fact-sleutels', () => {
    expect(() => buildFactIndex(EMPLOYMENT_CATALOG)).not.toThrow();
    expect(index.size).toBe(EMPLOYMENT_FACTS.length);
  });

  it('verwijst elk feit naar een bestaande categorie', () => {
    const categories = new Set(EMPLOYMENT_CATEGORIES.map((c) => c.key));
    const orphans = EMPLOYMENT_FACTS.filter((f) => !categories.has(f.category)).map((f) => f.key);
    expect(orphans).toEqual([]);
  });

  it('verwijst elke voorwaarde naar een bestaande fact-sleutel', () => {
    const dangling: string[] = [];
    for (const fact of EMPLOYMENT_FACTS) {
      if (!fact.relevantWhen) continue;
      for (const key of referencedKeys(fact.relevantWhen)) {
        if (!index.has(key)) dangling.push(`${fact.key} → ${key}`);
      }
    }
    for (const category of EMPLOYMENT_CATEGORIES) {
      if (!category.relevantWhen) continue;
      for (const key of referencedKeys(category.relevantWhen)) {
        if (!index.has(key)) dangling.push(`${category.key} → ${key}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('geeft elk feit een label en een hint in beide talen', () => {
    const incomplete = EMPLOYMENT_FACTS.filter(
      (f) => !f.label.nl || !f.label.en || !f.hint.nl || !f.hint.en,
    ).map((f) => f.key);
    expect(incomplete).toEqual([]);
  });

  it('geeft elk enum-feit een waardenlijst die de validator accepteert', () => {
    for (const fact of EMPLOYMENT_FACTS.filter((f) => f.valueType === 'enum')) {
      expect(fact.enumValues, `${fact.key} mist enumValues`).toBeDefined();
      for (const value of fact.enumValues!) {
        expect(fact.validator.safeParse(value).success, `${fact.key} = ${value}`).toBe(true);
      }
    }
  });

  it('markeert gezondheidsgegevens als bijzondere categorie', () => {
    // Arbeidsrechtelijke intakes gaan structureel over ziekte, bedrijfsarts en
    // re-integratie: dat is gezondheidsdata onder art. 9 AVG en vraagt om aparte
    // behandeling in logs en retentie.
    const illnessFacts = EMPLOYMENT_FACTS.filter((f) => f.category === 'illness');
    expect(illnessFacts.length).toBeGreaterThan(0);
    expect(illnessFacts.every((f) => f.specialCategory === true)).toBe(true);
  });

  it('dekt het demo-scenario volledig', () => {
    // §12: dit zijn de feiten die de assistent zelfstandig moet vaststellen.
    const required = [
      'contract_type',
      'employment_start_date',
      'gross_monthly_salary',
      'vso_received_date',
      'vso_signed',
      'vso_proposed_end_date',
      'currently_ill',
      'occupational_doctor_involved',
      'previous_warnings',
      'client_goal',
      'has_employment_contract',
    ];
    const missing = required.filter((k) => !index.has(k));
    expect(missing).toEqual([]);
  });

  it('activeert het VSO-blok pas als de route een VSO is', () => {
    const vsoFacts = EMPLOYMENT_FACTS.filter((f) => f.category === 'vso');
    expect(vsoFacts.length).toBeGreaterThan(3);
    // Elk VSO-feit hangt aan een voorwaarde; anders vraagt de assistent naar een
    // tekendeadline bij iemand die alleen een loonconflict heeft.
    expect(vsoFacts.every((f) => f.relevantWhen !== undefined)).toBe(true);
  });
});
