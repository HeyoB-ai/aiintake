import { describe, expect, it } from 'vitest';
import { dagdeelGroet, uurInZone } from './groet';

/**
 * De groet is een klokvraag, geen stijlvraag — en dus toetsbaar.
 *
 * Zonder deze functie koos het model zelf, en dat leverde "Goedemorgen" om acht uur
 * 's avonds op. De grenzen liggen hier vast zodat een volgende herformulering van de
 * prompt ze niet stilzwijgend kan verschuiven.
 */

/** Een moment in Amsterdamse lokale tijd, geschreven als UTC-offset. */
const zomer = (uurLokaal: number): Date => new Date(Date.UTC(2026, 6, 15, uurLokaal - 2, 30)); // juli: CEST = UTC+2
const winter = (uurLokaal: number): Date => new Date(Date.UTC(2026, 0, 15, uurLokaal - 1, 30)); // januari: CET = UTC+1

describe('dagdeelGroet', () => {
  it('groet naar het uur van de dag', () => {
    expect(dagdeelGroet(zomer(9), 'nl')).toBe('Goedemorgen');
    expect(dagdeelGroet(zomer(14), 'nl')).toBe('Goedemiddag');
    expect(dagdeelGroet(zomer(20), 'nl')).toBe('Goedenavond');
  });

  it('legt de grenzen vast op 6, 12 en 18 uur', () => {
    expect(dagdeelGroet(zomer(5), 'nl')).toBeNull();
    expect(dagdeelGroet(zomer(6), 'nl')).toBe('Goedemorgen');
    expect(dagdeelGroet(zomer(11), 'nl')).toBe('Goedemorgen');
    expect(dagdeelGroet(zomer(12), 'nl')).toBe('Goedemiddag');
    expect(dagdeelGroet(zomer(17), 'nl')).toBe('Goedemiddag');
    expect(dagdeelGroet(zomer(18), 'nl')).toBe('Goedenavond');
  });

  it('groet helemaal niet tussen middernacht en zes uur', () => {
    // "Goedenacht" is een afscheid en "goedenavond" om drie uur is vreemd. Niets zeggen
    // valt dan het minst op.
    for (const uur of [0, 2, 4, 5]) {
      expect(dagdeelGroet(zomer(uur), 'nl')).toBeNull();
      expect(dagdeelGroet(zomer(uur), 'en')).toBeNull();
    }
    expect(dagdeelGroet(zomer(6), 'nl')).toBe('Goedemorgen');
  });

  it('rekent in de Amsterdamse zone en niet in die van de server', () => {
    // Hetzelfde moment is 22:30 UTC en 00:30 in Amsterdam. Zou `getHours()` op een
    // UTC-server gebruikt worden, dan viel dit op "Goedenavond" om de verkeerde reden —
    // en om 10:30 UTC op "Goedemorgen" terwijl het in Amsterdam 12:30 is.
    expect(uurInZone(new Date('2026-07-15T22:30:00Z'))).toBe(0);
    expect(uurInZone(new Date('2026-07-15T10:30:00Z'))).toBe(12);
    expect(dagdeelGroet(new Date('2026-07-15T10:30:00Z'), 'nl')).toBe('Goedemiddag');
  });

  it('houdt rekening met zomertijd', () => {
    // Zelfde lokale uur, andere UTC-offset. Een vaste offset van +1 zou in juli een uur
    // mis zitten, en dat is precies rond de grens van 12 uur zichtbaar.
    expect(dagdeelGroet(zomer(12), 'nl')).toBe('Goedemiddag');
    expect(dagdeelGroet(winter(12), 'nl')).toBe('Goedemiddag');
    expect(dagdeelGroet(zomer(11), 'nl')).toBe('Goedemorgen');
    expect(dagdeelGroet(winter(11), 'nl')).toBe('Goedemorgen');
  });

  it('kent Engelse groeten met dezelfde grenzen', () => {
    expect(dagdeelGroet(zomer(9), 'en')).toBe('Good morning');
    expect(dagdeelGroet(zomer(14), 'en')).toBe('Good afternoon');
    expect(dagdeelGroet(zomer(20), 'en')).toBe('Good evening');
    // "Good night" is ook in het Engels een afscheid.
    expect(dagdeelGroet(zomer(3), 'en')).toBeNull();
  });

  it('volgt een andere tijdzone als die wordt meegegeven', () => {
    // Voorbereiding op een kantoor buiten Nederland: dit hoort dan een
    // organisatie-instelling te worden en geen wijziging in de code.
    const moment = new Date('2026-07-15T10:30:00Z');
    expect(dagdeelGroet(moment, 'nl', 'Europe/Amsterdam')).toBe('Goedemiddag');
    expect(dagdeelGroet(moment, 'nl', 'UTC')).toBe('Goedemorgen');
  });
});
