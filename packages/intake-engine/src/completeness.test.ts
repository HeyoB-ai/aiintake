import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_CATALOG,
  EMPLOYMENT_TEMPLATE,
  type CaseFact,
  type CaseFactMap,
} from '@intake/domain';
import { evaluate } from './conditions';
import { scoreCompleteness } from './completeness';

/**
 * De onderwerpentelling die het cliëntscherm laat zien.
 *
 * Een cliënt weet tijdens het gesprek niet of dit vijf of vijfentwintig minuten duurt. Wat hij
 * te zien krijgt is "drie van de zeven onderwerpen besproken", en dat getal komt hiervandaan.
 *
 * Bewust niet `completeness.score`: dat is een gewogen som met een afkapping voor openstaande
 * must-haves, en die als percentage tonen suggereert een precisie die er niet is. Een teller
 * van onderwerpen is grof en klopt.
 *
 * Deze tests bewaken twee dingen die allebei stil fout kunnen gaan: dat de teller **beweegt**
 * als er iets wordt beantwoord, en dat hij **onderwerpen** telt en niet feiten.
 */

function feit(key: string, value: unknown): CaseFact {
  return {
    key,
    value,
    valueType: 'string',
    status: 'confirmed',
    confidence: 0.9,
    source: 'client_statement',
    sourceRef: 'turn-1',
    llmCallId: null,
    updatedAt: '2026-08-22T09:00:00Z',
  };
}

/** Alle feitsleutels uit één categorie die op dit moment relevant zijn. */
function feitenIn(categorie: string, facts: CaseFactMap): string[] {
  return EMPLOYMENT_CATALOG.facts
    .filter((f) => f.category === categorie && evaluate(f.relevantWhen, facts))
    .map((f) => f.key);
}

describe('onderwerpen tellen voor het cliëntscherm', () => {
  it('telt nul onderwerpen bij een leeg dossier, en meer dan nul relevante', () => {
    const r = scoreCompleteness({}, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG);
    expect(r.topicsTouched).toBe(0);
    // Zonder deze tweede eis zou een noemer van nul de test halen, en dan toont het scherm
    // "0 van 0" — een balk die nooit beweegt en niets zegt.
    expect(r.topicsRelevant).toBeGreaterThan(0);
  });

  it('telt een onderwerp mee zodra er één feit uit is beantwoord', () => {
    const eersteCategorie = EMPLOYMENT_CATALOG.categories.find((c) => evaluate(c.relevantWhen, {}));
    expect(eersteCategorie).toBeDefined();
    const sleutels = feitenIn(eersteCategorie!.key, {});
    expect(sleutels.length).toBeGreaterThan(0);

    const facts: CaseFactMap = { [sleutels[0]!]: feit(sleutels[0]!, 'iets') };
    expect(scoreCompleteness(facts, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG).topicsTouched).toBe(1);
  });

  it('telt onderwerpen en geen feiten: twee feiten uit één categorie blijven één', () => {
    /*
     * Dit is de test die de vorm bewaakt. Zou `topicsTouched` per ongeluk feiten tellen, dan
     * loopt hij hard voorbij `topicsRelevant` en toont het scherm "9 van 7 onderwerpen".
     */
    const categorie = EMPLOYMENT_CATALOG.categories.find(
      (c) => evaluate(c.relevantWhen, {}) && feitenIn(c.key, {}).length >= 2,
    );
    expect(categorie).toBeDefined();
    const [a, b] = feitenIn(categorie!.key, {});

    const een: CaseFactMap = { [a!]: feit(a!, 'iets') };
    const twee: CaseFactMap = { [a!]: feit(a!, 'iets'), [b!]: feit(b!, 'nog iets') };

    expect(scoreCompleteness(een, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG).topicsTouched).toBe(1);
    expect(scoreCompleteness(twee, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG).topicsTouched).toBe(1);
  });

  it('komt nooit boven het aantal relevante onderwerpen uit', () => {
    // Alles beantwoorden wat er is. De teller mag dan gelijk zijn aan de noemer, niet hoger —
    // en een categorie die niet relevant is, hoort ook niet mee te tellen als hij gevuld is.
    // `CaseFactMap` is readonly; opbouwen en dan pas als zodanig doorgeven.
    const alles: CaseFactMap = Object.fromEntries(
      EMPLOYMENT_CATALOG.facts.map((f) => [f.key, feit(f.key, 'iets')]),
    );

    const r = scoreCompleteness(alles, EMPLOYMENT_TEMPLATE, EMPLOYMENT_CATALOG);
    expect(r.topicsTouched).toBeLessThanOrEqual(r.topicsRelevant);
  });
});
