import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_CATALOG,
  EMPLOYMENT_TEMPLATE,
  type CaseFact,
  type CaseFactMap,
} from '@intake/domain';
import { scoreCompleteness } from './completeness';
import { planQuestions } from './planner';
import { isBeantwoord, relevanteFeiten } from './relevantie';

/**
 * Eén antwoord op twee vragen, overal.
 *
 * ## Wat er misging
 *
 * "Doet dit feit er toe?" en "zijn we ermee klaar?" werden op drie plekken beantwoord en niet
 * overal hetzelfde:
 *
 *   - `planner.ts` en `completeness.ts` hadden een byte-identieke `isBeantwoord` waarin
 *     `unknown` meetelt; `engine.ts` vroeg bij `unknown` juist opnieuw.
 *   - `planner.ts` en `completeness.ts` toetsten de categorie én het feit; `engine.ts` alleen
 *     de categorie.
 *
 * Samen verklaren die twee waarom het volledigheidspercentage niet bij het gesprek paste: de
 * score zei "klaar" terwijl de assistent doorvroeg, en de extractie zocht naar feiten die
 * niemand vraagt en die nooit meetellen.
 *
 * ## Waarom een test en niet alleen één module
 *
 * Omdat de derde definitie er ook zonder kwade wil kwam. Twee ervan waren identiek, dus vanaf
 * elk van die twee zag het er goed uit — precies waarom je zoiets niet ziet aankomen. Deze test
 * kijkt naar de drie gebruikers tegelijk in plaats van naar de bron.
 */

function feit(key: string, status: CaseFact['status']): CaseFact {
  return {
    key,
    value: status === 'unknown' ? null : 'iets',
    valueType: 'string',
    status,
    confidence: status === 'unknown' ? 0 : 0.9,
    source: 'client_statement',
    sourceRef: status === 'unknown' ? null : 'turn-1',
    llmCallId: null,
    updatedAt: '2026-08-27T09:00:00Z',
  };
}

const NU = new Date('2026-08-27T10:00:00Z');

function plan(facts: CaseFactMap) {
  return planQuestions({
    catalog: EMPLOYMENT_CATALOG,
    template: EMPLOYMENT_TEMPLATE,
    rules: [],
    facts,
    turnCount: 3,
    language: 'nl',
    now: NU,
  });
}

describe('"zijn we klaar met dit feit" betekent overal hetzelfde', () => {
  const sleutel = EMPLOYMENT_CATALOG.facts.find((f) => f.category === 'trigger')!.key;

  it('telt `unknown` als beantwoord', () => {
    // "Dat weet ik niet" is een antwoord. De reden staat in relevantie.ts.
    expect(isBeantwoord({ [sleutel]: feit(sleutel, 'unknown') }, sleutel)).toBe(true);
  });

  it('laat de planner er niet opnieuw naar vragen', () => {
    const facts: CaseFactMap = { [sleutel]: feit(sleutel, 'unknown') };
    expect(plan(facts).candidates.some((c) => c.factKey === sleutel)).toBe(false);
  });

  it('telt hetzelfde feit ook mee in de score', () => {
    /*
     * Dit is het paar dat uiteenliep. Zou de planner er niet meer naar vragen terwijl de score
     * hem als open blijft tellen — of andersom — dan past het percentage niet bij het gesprek.
     * Deze twee assertions horen bij elkaar en falen samen.
     */
    const leeg = scoreCompleteness({}, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG);
    const metUnknown = scoreCompleteness(
      { [sleutel]: feit(sleutel, 'unknown') },
      EMPLOYMENT_TEMPLATE,
      EMPLOYMENT_CATALOG,
    );
    expect(metUnknown.answered).toBe(leeg.answered + 1);
  });

  it('laat `contradicted` wél terugkomen, bij alle drie', () => {
    // Daarover sprak de cliënt zichzelf tegen; dat is iets anders dan niet weten.
    const facts: CaseFactMap = { [sleutel]: feit(sleutel, 'contradicted') };
    expect(isBeantwoord(facts, sleutel)).toBe(false);
    expect(plan(facts).candidates.some((c) => c.factKey === sleutel)).toBe(true);
    expect(scoreCompleteness(facts, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG).answered).toBe(0);
  });
});

describe('"doet dit feit er toe" betekent overal hetzelfde', () => {
  /*
   * Het discriminerende geval, en het moest concreet.
   *
   * De eerste versie van deze test keek of er "minder feiten relevant zijn dan er bestaan".
   * Dat blijft waar zodra alleen de categorie wordt getoetst, dus hij bleef groen toen ik de
   * feit-voorwaarde eruit sloopte. Een test die niet kan falen voor de fout die hij benoemt,
   * is decoratie.
   *
   * `vso_signed_date` laat het wel zien. Zodra de ontslagroute een vaststellingsovereenkomst
   * is, wordt de categorie `vso` relevant en komen `vso_received_date` en `vso_signed` in
   * beeld. `vso_signed_date` niet: die heeft een eigen voorwaarde, er moet eerst getekend
   * zijn. Categorie relevant, feit niet.
   */
  const vsoRoute: CaseFactMap = {
    termination_route: {
      ...feit('termination_route', 'confirmed'),
      value: 'settlement_agreement',
    },
  };

  it('neemt een feit mee waarvan de categorie en de voorwaarde allebei aanslaan', () => {
    const sleutels = relevanteFeiten(EMPLOYMENT_CATALOG, vsoRoute).map((f) => f.key);
    expect(sleutels).toContain('vso_signed');
  });

  it('laat een feit vallen waarvan alleen de categorie aanslaat', () => {
    // Deze assertie faalt zodra `isRelevant` de feit-voorwaarde laat vallen.
    const sleutels = relevanteFeiten(EMPLOYMENT_CATALOG, vsoRoute).map((f) => f.key);
    expect(sleutels).not.toContain('vso_signed_date');
  });

  it('neemt hem alsnog mee zodra de voorwaarde wel aanslaat', () => {
    // Zonder deze eis zou een `isRelevant` die alles weigert de vorige test ook halen.
    const getekend: CaseFactMap = {
      ...vsoRoute,
      vso_signed: { ...feit('vso_signed', 'confirmed'), value: true },
    };
    const sleutels = relevanteFeiten(EMPLOYMENT_CATALOG, getekend).map((f) => f.key);
    expect(sleutels).toContain('vso_signed_date');
  });

  it('geeft de planner en de score dezelfde noemer', () => {
    // De planner vraagt uit dezelfde verzameling waaruit de score telt. Lopen ze uiteen, dan
    // vraagt de assistent naar iets wat het percentage nooit beweegt.
    expect(scoreCompleteness(vsoRoute, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG).relevant).toBe(
      relevanteFeiten(EMPLOYMENT_CATALOG, vsoRoute).length,
    );
  });
});
