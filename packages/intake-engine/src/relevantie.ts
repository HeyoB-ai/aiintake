import { evaluate } from './conditions';
import type { CaseFactMap, FactCatalog, FactDefinition } from '@intake/domain';

/**
 * Twee vragen die overal hetzelfde beantwoord moeten worden.
 *
 *   1. Doet dit feit er op dit moment toe?
 *   2. Zijn we er klaar mee?
 *
 * ## Waarom dit bestand er is
 *
 * Beide vragen werden op drie plekken beantwoord, en niet overal hetzelfde.
 *
 * **Vraag 1.** `planner.ts` en `completeness.ts` toetsten allebei de categorie én het feit zelf
 * (`relevantWhen`). `engine.ts` toetste alleen de categorie. Gevolg: de extractie zocht naar
 * feiten uit takken die de planner nooit vraagt en die de score nooit meetelt — een dossier dat
 * onvolledig oogt terwijl er van alles in staat wat niemand heeft gevraagd.
 *
 * **Vraag 2.** `planner.ts` en `completeness.ts` hadden een byte-identieke kopie van
 * `isBeantwoord`, waarin `unknown` meetelt. `engine.ts` besloot het tegenovergestelde en vroeg
 * bij `unknown` opnieuw. Gevolg: de score zei "klaar" terwijl de assistent bleef doorvragen.
 * Dat is precies de maat waarop een advocaat besluit of een dossier af is.
 *
 * ## Waarom `unknown` meetelt en niet andersom
 *
 * De planner had een uitgeschreven reden, de engine niet. Die reden staat hieronder en is
 * overgenomen: "dat weet ik niet" is een antwoord, en er daarna nog twee keer naar vragen is
 * precies het gedrag dat een gesprek in een formulier verandert.
 *
 * De keerzijde staat er ook bij, want die is echt: een verplicht feit dat `unknown` blijft,
 * telt mee in de score en houdt de intake dus niet tegen. De advocaat ziet het feit wél, met
 * status `unknown`, in het dossier. Wie dat anders wil — een openstaande must-have die de
 * intake blokkeert ook als de cliënt het niet weet — verandert dat híér, en dan verandert het
 * overal tegelijk. Dat is het hele punt van dit bestand.
 */

/**
 * Geldt een feit als beantwoord?
 *
 * `unknown` telt mee, en dat is een bewuste keuze. "Dat weet ik niet" is een antwoord. Er
 * daarna nog twee keer naar vragen is precies het gedrag dat een gesprek in een formulier
 * verandert — en de advocaat ziet in het dossier alsnog dat het feit `unknown` is.
 *
 * `contradicted` telt níét mee: een feit waarover de cliënt zichzelf tegensprak, moet juist
 * opnieuw langskomen.
 */
export function isBeantwoord(facts: CaseFactMap, key: string): boolean {
  const fact = facts[key];
  if (!fact) return false;
  return fact.status === 'confirmed' || fact.status === 'inferred' || fact.status === 'unknown';
}

/** De categorieën die er gegeven de huidige feiten toe doen. */
export function relevanteCategorieen(catalog: FactCatalog, facts: CaseFactMap): Set<string> {
  return new Set(
    catalog.categories.filter((c) => evaluate(c.relevantWhen, facts)).map((c) => c.key),
  );
}

/**
 * Doet dit feit er op dit moment toe?
 *
 * Twee voorwaarden, en ze zijn allebei nodig. De categorie moet relevant zijn — een
 * conditionele categorie waarvan de voorwaarde niet aanslaat, bestaat voor dit gesprek niet —
 * en het feit zélf moet relevant zijn. Dat tweede ontbrak in `engine.ts`.
 */
export function isRelevant(
  fact: FactDefinition,
  facts: CaseFactMap,
  categorieen: Set<string>,
): boolean {
  return categorieen.has(fact.category) && evaluate(fact.relevantWhen, facts);
}

/** Alle feiten die er nu toe doen. Eén lijst, voor wie hem in zijn geheel nodig heeft. */
export function relevanteFeiten(
  catalog: FactCatalog,
  facts: CaseFactMap,
): readonly FactDefinition[] {
  const categorieen = relevanteCategorieen(catalog, facts);
  return catalog.facts.filter((f) => isRelevant(f, facts, categorieen));
}
