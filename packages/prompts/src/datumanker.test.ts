import { describe, expect, it } from 'vitest';
import { datumAnker } from './datumanker';

/**
 * Het anker waarmee "afgelopen vrijdag" een datum wordt.
 *
 * De datum in `case_facts` hangt hiervan af, dus een fout hier is geen beleefdheidskwestie
 * maar een verkeerd feit in een juridisch dossier. Een vaste "nu" in elke test, zodat er
 * morgen niets omvalt.
 */

describe('datumAnker', () => {
  it('geeft de lokale datum en niet de UTC-datum', () => {
    /*
     * Het geval dat het mis ging.
     *
     * 22 augustus 23:30 UTC is 23 augustus 01:30 in Amsterdam. De oude code gebruikte
     * `toISOString().slice(0, 10)` en leverde dus 2026-08-22 — een cliënt die om half twee
     * 's nachts "gisteren" zei, kreeg eergisteren in het dossier.
     */
    const middernachtelijk = new Date('2026-08-22T23:30:00Z');
    expect(middernachtelijk.toISOString().slice(0, 10)).toBe('2026-08-22');
    expect(datumAnker(middernachtelijk, 'nl').iso).toBe('2026-08-23');
  });

  it('noemt de weekdag, want zonder die is "afgelopen vrijdag" niet uit te rekenen', () => {
    // 22 augustus 2026 is een zaterdag.
    const anker = datumAnker(new Date('2026-08-22T10:00:00Z'), 'nl');
    expect(anker.iso).toBe('2026-08-22');
    expect(anker.weekdag).toBe('zaterdag');
  });

  it('geeft de weekdag ook als getal, voor het deterministische vangnet', () => {
    // Maandag = 1 … zondag = 7. 22 augustus 2026 is een zaterdag, dus 6.
    expect(datumAnker(new Date('2026-08-22T10:00:00Z'), 'nl').weekdagIndex).toBe(6);
    expect(datumAnker(new Date('2026-08-24T10:00:00Z'), 'nl').weekdagIndex).toBe(1);
    expect(datumAnker(new Date('2026-08-23T10:00:00Z'), 'nl').weekdagIndex).toBe(7);
  });

  it('houdt naam en getal bij dezelfde dag, ook over de datumgrens', () => {
    // 23:30 UTC is de volgende dag in Amsterdam; naam en index horen dan allebei mee te
    // schuiven. Zouden ze uit elkaar lopen, dan spreken de prompt en het vangnet elkaar
    // tegen over welke dag het is.
    const a = datumAnker(new Date('2026-08-22T23:30:00Z'), 'nl');
    expect(a.iso).toBe('2026-08-23');
    expect(a.weekdag).toBe('zondag');
    expect(a.weekdagIndex).toBe(7);
  });

  it('geeft de weekdag in de taal van het gesprek', () => {
    const moment = new Date('2026-08-22T10:00:00Z');
    expect(datumAnker(moment, 'nl').weekdag).toBe('zaterdag');
    expect(datumAnker(moment, 'en').weekdag).toBe('Saturday');
  });

  it('geeft de lokale tijd, zodat "vanochtend" te plaatsen is', () => {
    // 10:00 UTC is 12:00 in Amsterdam in de zomer.
    expect(datumAnker(new Date('2026-08-22T10:00:00Z'), 'nl').tijd).toBe('12:00');
    // En 11:00 in de winter.
    expect(datumAnker(new Date('2026-01-22T10:00:00Z'), 'nl').tijd).toBe('11:00');
  });

  it('volgt de tijdzone van het kantoor', () => {
    const moment = new Date('2026-08-22T23:30:00Z');
    expect(datumAnker(moment, 'nl', 'Europe/Amsterdam').iso).toBe('2026-08-23');
    expect(datumAnker(moment, 'nl', 'UTC').iso).toBe('2026-08-22');
    // Een kantoor verder naar het westen zit op dat moment nog in de vorige dag.
    expect(datumAnker(moment, 'en', 'America/New_York').iso).toBe('2026-08-22');
  });

  it('draagt de zone mee, zodat een dossier naspeelbaar is', () => {
    // Zonder de zone in de prompt is achteraf niet vast te stellen tegen welk anker een
    // datum is uitgerekend.
    expect(datumAnker(new Date('2026-08-22T10:00:00Z'), 'nl', 'Europe/Berlin').timeZone).toBe(
      'Europe/Berlin',
    );
  });
});
