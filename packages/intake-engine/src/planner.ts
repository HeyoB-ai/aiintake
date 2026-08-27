import {
  EMPLOYMENT_CATALOG,
  ruleFactKeys,
  type CaseFactMap,
  type FactCatalog,
  type FactDefinition,
  type IntakeRule,
  type IntakeTemplate,
  type Language,
} from '@intake/domain';
import type { QuestionCandidate } from './types';
import { evaluate } from './conditions';
import { isBeantwoord, isRelevant, relevanteCategorieen } from './relevantie';
import { ruleFires, ruleIsUndecidable } from './rules';

/**
 * De QuestionPlanner.
 *
 * Kiest wélke feiten er nu toe doen. Hij formuleert géén vragen — dat doet het
 * hot-path model op basis van de hint. Dat onderscheid is het hele ontwerp: zou de
 * planner zinnen opleveren, dan klinkt de assistent als een formulier dat wordt
 * voorgelezen, en zou het model zelf mogen kiezen wat het vraagt, dan is er geen
 * verklaarbare volgorde en geen garantie dat de must-haves binnenkomen.
 *
 * Volledig deterministisch en synchroon. Geen I/O, geen model, geen willekeur: gegeven
 * dezelfde feiten volgt dezelfde lijst. Dat is wat de intake reproduceerbaar maakt en
 * wat het mogelijk maakt om achteraf te verklaren waarom iets gevraagd is.
 */

export interface PlannerInput {
  readonly catalog?: FactCatalog;
  readonly template: IntakeTemplate;
  readonly rules: readonly IntakeRule[];
  readonly facts: CaseFactMap;
  readonly turnCount: number;
  readonly language: Language;
  readonly now: Date;
  /** Wat de advocaat live heeft ingeschoten. Gaat boven alles heen. */
  readonly pendingLawyerRequests?: readonly string[];
  /** Feitsleutels die al uit een document zijn gehaald; niet opnieuw vragen. */
  readonly knownFromDocuments?: readonly string[];
}

export interface PlannerResult {
  readonly candidates: readonly QuestionCandidate[];
  /** Alles is binnen of het beurtenplafond is bereikt. */
  readonly shouldClose: boolean;
  readonly closeReason: 'complete' | 'max_turns' | null;
}

/** Hoeveel kandidaten het hot-path model krijgt aangeboden. */
const MAX_CANDIDATES = 3;

/**
 * Gewichten. Ze staan hier bij elkaar zodat het afstemmen van de intake één plek heeft
 * en geen speurtocht door de code wordt.
 */
const GEWICHT = {
  /** Een must-have die nog niet binnen is. Domineert alles behalve een advocaatverzoek. */
  required: 60,
  /** Verzoek van de advocaat tijdens het gesprek. Gaat per definitie voor. */
  lawyerRequest: 200,
  /** Feit dat meeweegt in de aanname-beslissing van het kantoor. */
  criteria: 1,
  /** Feit dat urgentie kan bepalen. */
  urgency: 15,
  /** Aftrek per beurt boven fatigueAfterTurns, alleen op optionele feiten. */
  fatiguePerTurn: 4,
  /** Bonus als een feit hoort bij de categorie waar we al zijn — minder heen en weer. */
  sameCategory: 8,
} as const;

export function planQuestions(input: PlannerInput): PlannerResult {
  const catalog = input.catalog ?? EMPLOYMENT_CATALOG;
  const { facts, template, rules, now } = input;
  const lawyerRequests = new Set(input.pendingLawyerRequests ?? []);
  const uitDocument = new Set(input.knownFromDocuments ?? []);

  // Welke categorieën doen er überhaupt toe? Een conditionele categorie waarvan de
  // voorwaarde niet aanslaat, bestaat voor dit gesprek niet.
  const categorieen = relevanteCategorieen(catalog, facts);

  // Welke feiten kan een nog-onbeslisbare regel bevestigen of uitsluiten? Alleen regels
  // die nog niet zijn afgegaan én nog niet zijn uitgesloten trekken iets naar voren.
  const regelBoost = new Map<string, number>();
  for (const regel of rules) {
    if (!ruleIsUndecidable(regel, facts, now)) continue;
    for (const key of ruleFactKeys(regel)) {
      regelBoost.set(key, Math.max(regelBoost.get(key) ?? 0, regel.plannerBoost));
    }
  }

  const huidigeCategorie = laatstBeantwoordeCategorie(catalog, facts);

  const openstaand: Array<{ fact: FactDefinition; score: number; reasons: string[] }> = [];
  const openMustHaves: string[] = [];

  for (const fact of catalog.facts) {
    if (!isRelevant(fact, facts, categorieen)) continue;
    if (isBeantwoord(facts, fact.key)) continue;
    if (uitDocument.has(fact.key)) continue;

    const isRequired = template.requiredFactKeys.includes(fact.key) || fact.required;
    if (isRequired) openMustHaves.push(fact.key);

    const reasons: string[] = [];
    let score = fact.priority;

    if (lawyerRequests.has(fact.key)) {
      score += GEWICHT.lawyerRequest;
      reasons.push('verzoek van de advocaat');
    }
    if (isRequired) {
      score += GEWICHT.required;
      reasons.push('must-have voor afronding');
    }
    if (fact.criteriaWeight) {
      score += fact.criteriaWeight * GEWICHT.criteria;
      reasons.push('weegt mee in de aanname-beslissing');
    }
    if (fact.urgencyRelevant) {
      score += GEWICHT.urgency;
      reasons.push('kan urgentie bepalen');
    }
    const boost = regelBoost.get(fact.key);
    if (boost) {
      score += boost;
      reasons.push('nodig om een urgentieregel te beslissen');
    }
    if (huidigeCategorie && fact.category === huidigeCategorie) {
      score += GEWICHT.sameCategory;
      reasons.push('sluit aan bij het huidige onderwerp');
    }

    // Vermoeidheid. Alleen op optionele feiten: een gesprek mag korter worden, maar
    // niet onvolledig op de punten waarop de advocaat moet kunnen beslissen.
    const overtijd = input.turnCount - template.fatigueAfterTurns;
    if (overtijd > 0 && !isRequired) {
      score -= overtijd * GEWICHT.fatiguePerTurn;
      reasons.push('lager gewogen omdat het gesprek al lang duurt');
    }

    openstaand.push({ fact, score, reasons });
  }

  // Sorteren op score; bij gelijke score de templatevolgorde van de categorie, en
  // daarbinnen de feitsleutel. Die laatste tiebreak lijkt overbodig maar is het niet:
  // zonder een totale ordening is de planner niet reproduceerbaar, en dan is "waarom
  // vroeg hij dít" achteraf niet te beantwoorden.
  const volgorde = new Map(catalog.categories.map((c) => [c.key, c.order]));
  openstaand.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ca = volgorde.get(a.fact.category) ?? 999;
    const cb = volgorde.get(b.fact.category) ?? 999;
    if (ca !== cb) return ca - cb;
    return a.fact.key < b.fact.key ? -1 : 1;
  });

  const maxBereikt = input.turnCount >= template.maxTurns;

  // Bij het beurtenplafond alleen nog must-haves; is ook dat leeg, dan afronden.
  const bruikbaar = maxBereikt
    ? openstaand.filter((k) => openMustHaves.includes(k.fact.key))
    : openstaand;

  const candidates = bruikbaar.slice(0, MAX_CANDIDATES).map(({ fact, score, reasons }) => ({
    factKey: fact.key,
    score: Math.round(score),
    hint: fact.hint[input.language],
    label: fact.label[input.language],
    reasons,
  }));

  const compleet = openMustHaves.length === 0;
  return {
    candidates,
    shouldClose: compleet || candidates.length === 0,
    closeReason: compleet ? 'complete' : candidates.length === 0 ? 'max_turns' : null,
  };
}

/** De categorie van het laatst binnengekomen feit; stuurt de samenhang van het gesprek. */
function laatstBeantwoordeCategorie(catalog: FactCatalog, facts: CaseFactMap): string | null {
  let laatste: { key: string; at: string } | null = null;
  for (const [key, fact] of Object.entries(facts)) {
    if (!fact?.updatedAt) continue;
    if (!laatste || fact.updatedAt > laatste.at) laatste = { key, at: fact.updatedAt };
  }
  if (!laatste) return null;
  return catalog.facts.find((f) => f.key === laatste.key)?.category ?? null;
}

/** Herexporteren zodat de engine niet twee modules hoeft te kennen. */
export { ruleFires };
