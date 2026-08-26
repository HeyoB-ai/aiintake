import { describe, expect, it } from 'vitest';
import { contactCompleet } from './scherm-toestemming';

/**
 * De poort vóór het gesprek.
 *
 * Deze regel bestaat twee keer met opzet: hier als gemak voor wie het formulier invult, en
 * in `create_public_intake` als grens. Wat hier wordt getoetst is uitsluitend de eerste —
 * dat de knop niet opengaat bij een halve invulling. Of de database hem óók weigert, is een
 * andere bewering, en die staat in de migratie.
 */
describe('contactCompleet', () => {
  it('weigert een lege invulling', () => {
    expect(contactCompleet('', '', '')).toBe(false);
  });

  it('weigert een naam zonder enig contactkanaal', () => {
    expect(contactCompleet('Sanne de Vries', '', '')).toBe(false);
  });

  it('weigert een contactkanaal zonder naam', () => {
    expect(contactCompleet('', 'sanne@voorbeeld.nl', '')).toBe(false);
  });

  it('accepteert naam met alleen e-mail', () => {
    expect(contactCompleet('Sanne de Vries', 'sanne@voorbeeld.nl', '')).toBe(true);
  });

  it('accepteert naam met alleen telefoon', () => {
    expect(contactCompleet('Sanne de Vries', '', '0612345678')).toBe(true);
  });

  it('telt witruimte niet als invulling', () => {
    // Een veld dat is aangeraakt en weer leeggemaakt levert vaak een spatie op. Zonder
    // trimmen gaat de knop dan open en weigert de database pas ná het toestemmingsscherm.
    expect(contactCompleet('  ', '   ', '  ')).toBe(false);
    expect(contactCompleet('Sanne de Vries', '   ', '  ')).toBe(false);
  });

  it('weigert een naam van één teken', () => {
    // Niet omdat één letter onmogelijk is, maar omdat het vrijwel altijd een typefout of
    // een test is. De grens ligt gelijk met die in create_public_intake.
    expect(contactCompleet('S', 'sanne@voorbeeld.nl', '')).toBe(false);
  });
});
