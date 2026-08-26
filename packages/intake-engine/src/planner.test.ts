import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_CATALOG,
  EMPLOYMENT_RULES,
  EMPLOYMENT_TEMPLATE,
  type CaseFact,
  type CaseFactMap,
} from '@intake/domain';
import { conversationPrompt } from '@intake/prompts';
import { evaluate } from './conditions';
import { planQuestions } from './planner';
import { evaluateRules, urgencyLevel } from './rules';
import { scoreCompleteness } from './completeness';

const NU = new Date('2026-08-22T10:00:00Z');

/**
 * De must-haves voor een gegeven dossier: verplicht in de catalogus of in het template,
 * en relevant gegeven de feiten die er nu liggen.
 */
function mustHaveKeys(facts: CaseFactMap): string[] {
  const relevanteCategorieen = new Set(
    EMPLOYMENT_CATALOG.categories.filter((c) => evaluate(c.relevantWhen, facts)).map((c) => c.key),
  );
  return EMPLOYMENT_CATALOG.facts
    .filter(
      (f) =>
        (f.required || EMPLOYMENT_TEMPLATE.requiredFactKeys.includes(f.key)) &&
        relevanteCategorieen.has(f.category) &&
        evaluate(f.relevantWhen, facts),
    )
    .map((f) => f.key);
}

/** Losse feiten opbouwen zonder cast: de velden staan er allemaal, ook de saaie. */
function feit(key: string, value: unknown, status: CaseFact['status'] = 'confirmed'): CaseFact {
  return {
    key,
    value,
    valueType: 'string',
    status,
    confidence: 0.9,
    source: 'client_statement',
    sourceRef: 'turn-1',
    llmCallId: null,
    updatedAt: '2026-08-22T09:00:00Z',
  };
}

/** Muteerbare variant; CaseFactMap is readonly en dat hoort ook zo. */
type Dossier = Record<string, CaseFact>;

function plan(
  facts: CaseFactMap,
  turnCount = 0,
  extra: Partial<Parameters<typeof planQuestions>[0]> = {},
) {
  return planQuestions({
    template: EMPLOYMENT_TEMPLATE,
    rules: EMPLOYMENT_RULES,
    facts,
    turnCount,
    language: 'nl',
    now: NU,
    ...extra,
  });
}

describe('QuestionPlanner', () => {
  /**
   * Deze test bewaakt de aanname waar de test hieronder op steunt.
   *
   * De planner mag op een leeg dossier termination_route boven primary_issue zetten,
   * maar dat is alleen verdedigbaar zolang de openingsbeurt de kandidatenlijst negeert
   * en gewoon open vraagt waar het om gaat. Wordt het promptsjabloon ooit zo aangepast
   * dat de opening wél kandidaten voorschotelt, dan begint het gesprek met een gesloten
   * vraag over de ontslagroute — en dan moet de plannervolgorde opnieuw tegen het licht.
   *
   * Vandaar dat de aanname hier expliciet staat en niet impliciet in een commentaarregel:
   * een aanname die nergens faalt, is een aanname die stilletjes verdwijnt.
   */
  it('de opening negeert de kandidatenlijst — aanname onder de volgordetest hieronder', () => {
    const body = conversationPrompt.render(
      {
        organisationName: 'Kantoor De Vries',
        practiceAreaLabel: 'arbeidsrecht',
        candidates: [
          { factKey: 'termination_route', label: 'Ontslagroute', hint: 'Hoe is het gegaan?' },
        ],
        knownFacts: [],
        maxSentences: 3,
        allowFiller: false,
        isOpening: true,
        isClosing: false,
        narrativePhase: true,
        greeting: 'Goedemiddag',
        clientName: null,
      },
      'nl',
    );
    expect(body).toContain('Dit is de opening');
    expect(body).not.toContain('Ontslagroute');
    expect(body).not.toContain('Kies één van deze onderwerpen');
  });

  it('zet bij een leeg dossier de trigger-categorie vooraan', () => {
    // Niet per se primary_issue: termination_route wint omdat er urgentieregels aan
    // hangen die zonder dat feit niet te beslissen zijn. Dat is verdedigbaar, want de
    // openingsbeurt stelt sowieso een open vraag en gebruikt de kandidatenlijst niet
    // (zie engine.test.ts) - primary_issue komt meestal gratis uit dat antwoord.
    const r = plan({});
    const eerste = r.candidates[0];
    expect(eerste).toBeDefined();
    const categorie = EMPLOYMENT_CATALOG.facts.find((f) => f.key === eerste?.factKey)?.category;
    expect(categorie).toBe('trigger');
    expect(r.shouldClose).toBe(false);
  });

  it('stelt geen vragen uit een categorie waarvan de voorwaarde niet aanslaat', () => {
    // Zonder termination_route = settlement_agreement bestaat het VSO-blok niet voor
    // dit gesprek. Anders zou elke cliënt VSO-vragen krijgen.
    const zonder = plan({ primary_issue: feit('primary_issue', 'wage') });
    expect(zonder.candidates.map((c) => c.factKey)).not.toContain('vso_signing_deadline');

    const met = plan({
      primary_issue: feit('primary_issue', 'termination'),
      termination_route: feit('termination_route', 'settlement_agreement'),
    });
    const alle = planQuestions({
      template: EMPLOYMENT_TEMPLATE,
      rules: EMPLOYMENT_RULES,
      facts: {
        primary_issue: feit('primary_issue', 'termination'),
        termination_route: feit('termination_route', 'settlement_agreement'),
      },
      turnCount: 0,
      language: 'nl',
      now: NU,
    });
    expect(met.candidates.length).toBeGreaterThan(0);
    expect(alle.candidates.length).toBeGreaterThan(0);
  });

  it('trekt een feit naar voren waar een onbesliste urgentieregel op wacht', () => {
    const facts: Dossier = {
      primary_issue: feit('primary_issue', 'termination'),
      termination_route: feit('termination_route', 'settlement_agreement'),
    };
    const r = plan(facts);
    // vso_signing_deadline beslist vso_deadline_imminent (boost 40). Dat moet het naar
    // boven duwen, anders ontdek je de tekendeadline pas in beurt dertig.
    const keys = r.candidates.map((c) => c.factKey);
    expect(keys).toContain('vso_signing_deadline');
    const kandidaat = r.candidates.find((c) => c.factKey === 'vso_signing_deadline');
    expect(kandidaat?.reasons).toContain('nodig om een urgentieregel te beslissen');
  });

  it('laat een verzoek van de advocaat alles overrulen', () => {
    const r = plan({ primary_issue: feit('primary_issue', 'wage') }, 5, {
      pendingLawyerRequests: ['legal_expenses_insurance'],
    });
    expect(r.candidates[0]?.factKey).toBe('legal_expenses_insurance');
    expect(r.candidates[0]?.reasons).toContain('verzoek van de advocaat');
  });

  it('beschouwt "weet ik niet" als beantwoord en vraagt er niet opnieuw naar', () => {
    const r = plan({ primary_issue: feit('primary_issue', null, 'unknown') });
    expect(r.candidates.map((c) => c.factKey)).not.toContain('primary_issue');
  });

  it('vraagt een tegengesproken feit juist opnieuw', () => {
    const r = plan({ primary_issue: feit('primary_issue', 'wage', 'contradicted') });
    expect(r.candidates.map((c) => c.factKey)).toContain('primary_issue');
  });

  it('is reproduceerbaar: dezelfde feiten geven dezelfde volgorde', () => {
    const facts: Dossier = { primary_issue: feit('primary_issue', 'termination') };
    expect(plan(facts).candidates).toEqual(plan(facts).candidates);
  });

  it('stelt na het beurtenplafond alleen nog must-haves', () => {
    const facts: Dossier = { primary_issue: feit('primary_issue', 'wage') };
    const r = plan(facts, EMPLOYMENT_TEMPLATE.maxTurns);
    const musts = new Set(mustHaveKeys(facts));
    for (const c of r.candidates) expect(musts.has(c.factKey)).toBe(true);
  });

  it('rondt af zodra alle must-haves binnen zijn', () => {
    // Alleen de must-haves invullen die voor dít gesprek relevant zijn. Een loonzaak
    // hoeft de VSO-feiten niet te kennen; dat is precies wat de conditionele
    // categorieën doen.
    const facts: Dossier = {
      primary_issue: feit('primary_issue', 'wage'),
      termination_route: feit('termination_route', 'none'),
    };
    for (const key of mustHaveKeys(facts)) facts[key] = feit(key, 'x');
    const r = plan(facts);
    expect(r.shouldClose).toBe(true);
    expect(r.closeReason).toBe('complete');
  });
});

describe('urgentieregels', () => {
  it('meldt een tekendeadline binnen zeven dagen als CRITICAL', () => {
    const facts: Dossier = { vso_signing_deadline: feit('vso_signing_deadline', '2026-08-26') };
    expect(urgencyLevel(EMPLOYMENT_RULES, facts, NU)).toBe('CRITICAL');
  });

  it('telt een verstreken deadline niet als naderend', () => {
    // Verstreken is een ander signaal dan naderend; daar is elapsedSince voor. Zou
    // deadlineWithin ook negatieve dagen accepteren, dan blijft een zaak van vorig jaar
    // eeuwig CRITICAL en wordt het signaal betekenisloos.
    const facts: Dossier = { vso_signing_deadline: feit('vso_signing_deadline', '2026-08-01') };
    const gevuurd = evaluateRules(EMPLOYMENT_RULES, facts, NU).map((r) => r.ruleKey);
    expect(gevuurd).not.toContain('vso_deadline_imminent');
  });

  it('slaat aan op een vervaltermijn die na 46 dagen nadert', () => {
    const facts: Dossier = { summary_dismissal_date: feit('summary_dismissal_date', '2026-07-01') };
    const gevuurd = evaluateRules(EMPLOYMENT_RULES, facts, NU).map((r) => r.ruleKey);
    expect(gevuurd).toContain('summary_dismissal_window_closing');
  });

  it('vereist beide feiten voor het concurrentiebeding-signaal', () => {
    const half: Dossier = { non_compete_clause: feit('non_compete_clause', true) };
    expect(evaluateRules(EMPLOYMENT_RULES, half, NU).map((r) => r.ruleKey)).not.toContain(
      'non_compete_blocks_new_job',
    );

    const heel: Dossier = {
      non_compete_clause: feit('non_compete_clause', true),
      new_employer_lined_up: feit('new_employer_lined_up', true),
    };
    expect(evaluateRules(EMPLOYMENT_RULES, heel, NU).map((r) => r.ruleKey)).toContain(
      'non_compete_blocks_new_job',
    );
  });

  it('geeft LOW als er niets afgaat', () => {
    expect(urgencyLevel(EMPLOYMENT_RULES, {}, NU)).toBe('LOW');
  });
});

describe('volledigheidsscore', () => {
  it('houdt de score onder de drempel zolang een must-have ontbreekt', () => {
    const facts: Dossier = { termination_route: feit('termination_route', 'none') };
    for (const key of mustHaveKeys(facts).filter((k) => k !== 'primary_issue')) {
      facts[key] = feit(key, 'x');
    }
    // Alles behalve primary_issue. Zonder de afkap zou veel optionele detailinformatie
    // dit alsnog boven de drempel kunnen tillen.
    const r = scoreCompleteness(facts, EMPLOYMENT_TEMPLATE);
    expect(r.missingRequiredKeys).toContain('primary_issue');
    expect(r.score).toBeLessThan(EMPLOYMENT_TEMPLATE.completionThreshold);
  });

  it('telt alleen relevante categorieën mee', () => {
    // Een loonzaak wordt niet incompleet doordat er geen VSO-vragen zijn beantwoord.
    const loon = scoreCompleteness(
      { primary_issue: feit('primary_issue', 'wage') },
      EMPLOYMENT_TEMPLATE,
    );
    const vso = scoreCompleteness(
      {
        primary_issue: feit('primary_issue', 'termination'),
        termination_route: feit('termination_route', 'settlement_agreement'),
      },
      EMPLOYMENT_TEMPLATE,
    );
    expect(vso.relevant).toBeGreaterThan(loon.relevant);
  });
});
