import {
  EMPLOYMENT_CATALOG,
  type CaseFactMap,
  type FactCatalog,
  type IntakeTemplate,
} from '@intake/domain';
import { isBeantwoord, isRelevant, relevanteCategorieen } from './relevantie';

/**
 * De volledigheidsscore.
 *
 * Eén getal dat zegt of de advocaat genoeg heeft. Het telt alleen feiten mee die voor
 * dít gesprek relevant zijn: een intake over een loonconflict wordt niet incompleet
 * omdat er geen VSO-vragen zijn beantwoord.
 *
 * Must-haves wegen zwaarder dan optionele feiten, en de score kan de drempel niet halen
 * zolang er een must-have openstaat — anders zou een intake met veel randinformatie en
 * een ontbrekende einddatum "compleet" heten.
 */

const GEWICHT_REQUIRED = 3;
const GEWICHT_OPTIONEEL = 1;

export interface CompletenessResult {
  readonly score: number;
  readonly missingRequiredKeys: readonly string[];
  /** Aantal relevante feiten dat is beantwoord, en hoeveel er relevant waren. */
  readonly answered: number;
  readonly relevant: number;
  /**
   * Hetzelfde, maar per onderwerp: hoeveel categorieën zijn aangeraakt van hoeveel relevante.
   *
   * Grover dan de feitentelling, en dat is met opzet. Dit is het getal dat een cliënt te zien
   * krijgt, en "vier van de zeven onderwerpen" is iets wat iemand kan plaatsen. "Elf van de
   * negenentwintig gegevens" suggereert een precisie die er niet is: of een feit relevant is,
   * hangt af van feiten die nog moeten komen, dus de noemer beweegt tijdens het gesprek.
   *
   * Een categorie telt als aangeraakt zodra er één feit uit beantwoord is. Dat is een
   * bescheiden claim — het zegt "hierover is gesproken", niet "dit is afgerond".
   */
  readonly topicsTouched: number;
  readonly topicsRelevant: number;
}

export function scoreCompleteness(
  facts: CaseFactMap,
  template: IntakeTemplate,
  catalog: FactCatalog = EMPLOYMENT_CATALOG,
): CompletenessResult {
  const categorieen = relevanteCategorieen(catalog, facts);

  let behaald = 0;
  let maximum = 0;
  let answered = 0;
  let relevant = 0;
  const missingRequiredKeys: string[] = [];
  const aangeraakteCategorieen = new Set<string>();

  for (const fact of catalog.facts) {
    if (!isRelevant(fact, facts, categorieen)) continue;

    const isRequired = template.requiredFactKeys.includes(fact.key) || fact.required;
    const gewicht = isRequired ? GEWICHT_REQUIRED : GEWICHT_OPTIONEEL;
    maximum += gewicht;
    relevant += 1;

    if (isBeantwoord(facts, fact.key)) {
      behaald += gewicht;
      answered += 1;
      aangeraakteCategorieen.add(fact.category);
    } else if (isRequired) {
      missingRequiredKeys.push(fact.key);
    }
  }

  const ruw = maximum === 0 ? 1 : behaald / maximum;

  // Een openstaande must-have kapt de score af onder de drempel. Zonder deze regel kan
  // een gesprek vol optionele details de drempel halen terwijl het salaris ontbreekt, en
  // dan meldt het systeem "compleet" over een intake waar de advocaat niets mee kan.
  const score =
    missingRequiredKeys.length > 0
      ? Math.min(ruw, Math.max(0, template.completionThreshold - 0.01))
      : ruw;

  return {
    score: Math.round(score * 100) / 100,
    missingRequiredKeys,
    answered,
    relevant,
    topicsTouched: aangeraakteCategorieen.size,
    topicsRelevant: categorieen.size,
  };
}
