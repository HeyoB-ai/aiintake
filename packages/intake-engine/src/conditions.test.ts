import { describe, expect, it } from 'vitest';
import type { CaseFact, CaseFactMap } from '@intake/domain';
import { anyOf, factEquals, factIn, factKnown, not } from '@intake/domain';
import { daysSince, daysUntil, evaluate } from './conditions';

function fact(value: unknown, status: CaseFact['status'] = 'confirmed'): CaseFact {
  return {
    key: 'x',
    value,
    valueType: 'string',
    status,
    confidence: status === 'unknown' ? 0 : 0.9,
    source: 'client_statement',
    sourceRef: status === 'unknown' ? null : 'msg-1',
    llmCallId: null,
  };
}

const facts = (entries: Record<string, CaseFact>): CaseFactMap => entries;

describe('conditionele relevantie', () => {
  it('zonder voorwaarde is alles relevant', () => {
    expect(evaluate(undefined, facts({}))).toBe(true);
  });

  it('factEquals slaat aan bij een bevestigd feit', () => {
    const state = facts({ termination_route: fact('settlement_agreement') });
    expect(evaluate(factEquals('termination_route', 'settlement_agreement'), state)).toBe(true);
    expect(evaluate(factEquals('termination_route', 'summary_dismissal'), state)).toBe(false);
  });

  it('een expliciet onbekend feit bevestigt niets', () => {
    // Dit is de kern van waarom `unknown` een opslaanbare waarde is: het onderscheid
    // tussen "we weten het niet" en "het is niet zo" moet in de logica bestaan.
    const state = facts({ vso_signed: fact(true, 'unknown') });
    expect(evaluate(factEquals('vso_signed', true), state)).toBe(false);
    expect(evaluate(factKnown('vso_signed'), state)).toBe(false);
  });

  it('een ontbrekend feit is niet hetzelfde als false', () => {
    expect(evaluate(factEquals('currently_ill', false), facts({}))).toBe(false);
    expect(evaluate(not(factEquals('currently_ill', false)), facts({}))).toBe(true);
  });

  it('factIn, anyOf en not schakelen zoals verwacht', () => {
    const state = facts({ contract_type: fact('fixed_term') });
    expect(evaluate(factIn('contract_type', ['permanent', 'fixed_term']), state)).toBe(true);
    expect(
      evaluate(anyOf(factEquals('contract_type', 'zzp'), factKnown('contract_type')), state),
    ).toBe(true);
    expect(evaluate(not(factEquals('contract_type', 'fixed_term')), state)).toBe(false);
  });

  it('vergelijkt booleans en getallen op waarde, niet op tekst', () => {
    expect(evaluate(factEquals('a', true), facts({ a: fact(true) }))).toBe(true);
    expect(evaluate(factEquals('a', true), facts({ a: fact('true') }))).toBe(false);
    expect(evaluate(factEquals('a', 3500), facts({ a: fact(3500) }))).toBe(true);
  });
});

describe('termijnen', () => {
  const now = new Date('2026-08-22T14:30:00Z');

  it('telt dagen tot een datum, ongeacht het tijdstip vandaag', () => {
    expect(daysUntil('2026-08-28', now)).toBe(6);
    expect(daysUntil('2026-08-22', now)).toBe(0);
    expect(daysUntil('2026-08-20', now)).toBe(-2);
  });

  it('daysSince is het spiegelbeeld', () => {
    expect(daysSince('2026-08-20', now)).toBe(2);
  });

  it('geeft null bij onbruikbare invoer in plaats van te gokken', () => {
    expect(daysUntil('vrijdag', now)).toBeNull();
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil(undefined, now)).toBeNull();
    expect(daysUntil(20260828, now)).toBeNull();
  });
});
