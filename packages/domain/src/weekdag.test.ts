import { describe, expect, it } from 'vitest';
import { resolveWeekdag, vindWeekdagVerwijzing, type WeekdagIndex } from './weekdag';

/**
 * Het vangnet voor weekdagverwijzingen.
 *
 * Vast anker: **zaterdag 22 augustus 2026** (ISO-weekdag 6). Vast, zodat deze tests morgen
 * niet omvallen op de kalender in plaats van op een regressie.
 */

const ANKER = '2026-08-22';
const ANKER_DAG: WeekdagIndex = 6; // zaterdag

function reken(uitspraak: string, language: 'nl' | 'en' = 'nl'): string | null {
  const v = vindWeekdagVerwijzing(uitspraak, language);
  return v ? resolveWeekdag(ANKER, ANKER_DAG, v) : null;
}

describe('vindWeekdagVerwijzing', () => {
  it('vindt een weekdag en hoe ernaar verwezen wordt', () => {
    expect(vindWeekdagVerwijzing('Ik ben afgelopen vrijdag ontslagen.')).toMatchObject({
      weekdag: 5,
      richting: 'recentste',
    });
    expect(vindWeekdagVerwijzing('Dat was vorige week maandag.')).toMatchObject({
      weekdag: 1,
      richting: 'vorigeWeek',
    });
  });

  it('bemoeit zich niet met een uitspraak zonder weekdag', () => {
    expect(vindWeekdagVerwijzing('Ik ben twee maanden geleden ontslagen.')).toBeNull();
    expect(vindWeekdagVerwijzing('Dat was op 3 maart.')).toBeNull();
  });

  it('laat een expliciete datum met rust', () => {
    // "vrijdag 21 augustus" hoeft niet uitgerekend te worden; het vangnet hoort dan niets
    // te doen in plaats van iets te overschrijven dat al klopt.
    expect(vindWeekdagVerwijzing('Dat was vrijdag 21 augustus.')).toBeNull();
    expect(vindWeekdagVerwijzing('Op maandag 3 maart ben ik begonnen.')).toBeNull();
  });
});

describe('resolveWeekdag vanaf zaterdag 22 augustus 2026', () => {
  it('rekent "afgelopen vrijdag" naar de dag ervoor', () => {
    // Dit is het geval dat het model fout deed: het gaf 2026-08-18, een dinsdag.
    expect(reken('Ik ben afgelopen vrijdag ontslagen.')).toBe('2026-08-21');
  });

  it('rekent "vorige week maandag" naar de vorige kalenderweek', () => {
    // Vandaag valt in de week van maandag 17 augustus; de vorige week begint op de 10e.
    // Het model gaf hier óók 2026-08-18.
    expect(reken('Dat was vorige week maandag.')).toBe('2026-08-10');
  });

  it('onderscheidt "afgelopen maandag" van "vorige week maandag"', () => {
    /*
     * Het verschil is een hele week, en in een vervaltermijn telt dat.
     *
     * Vandaag is zaterdag 22 augustus. De maandag daarvóór is de 17e — dat is "afgelopen
     * maandag". "Vorige week maandag" is de maandag van de vorige kalenderweek: de 10e.
     */
    expect(reken('Dat was afgelopen maandag.')).toBe('2026-08-17');
    expect(reken('Dat was vorige week maandag.')).toBe('2026-08-10');
  });

  it('gaat een week terug als de genoemde dag vandaag is', () => {
    // "Afgelopen zaterdag" gezegd op een zaterdag betekent vorige week, niet vandaag.
    expect(reken('Dat was afgelopen zaterdag.')).toBe('2026-08-15');
  });

  it('werkt voor elke dag van de week', () => {
    expect(reken('afgelopen zondag')).toBe('2026-08-16');
    expect(reken('afgelopen maandag')).toBe('2026-08-17');
    expect(reken('afgelopen dinsdag')).toBe('2026-08-18');
    expect(reken('afgelopen woensdag')).toBe('2026-08-19');
    expect(reken('afgelopen donderdag')).toBe('2026-08-20');
    expect(reken('afgelopen vrijdag')).toBe('2026-08-21');
  });

  it('rekent over een maandgrens heen', () => {
    // Anker: dinsdag 1 september 2026 (ISO-weekdag 2).
    const v = vindWeekdagVerwijzing('Dat was afgelopen donderdag.');
    expect(v).not.toBeNull();
    if (v) expect(resolveWeekdag('2026-09-01', 2, v)).toBe('2026-08-27');
  });

  it('rekent over een jaargrens heen', () => {
    // Anker: vrijdag 1 januari 2027 (ISO-weekdag 5).
    const v = vindWeekdagVerwijzing('Dat was vorige week woensdag.');
    expect(v).not.toBeNull();
    if (v) expect(resolveWeekdag('2027-01-01', 5, v)).toBe('2026-12-23');
  });

  it('kent Engelse weekdagen', () => {
    expect(reken('That was last Friday.', 'en')).toBe('2026-08-21');
    expect(reken('That was last week Monday.', 'en')).toBe('2026-08-10');
  });
});
