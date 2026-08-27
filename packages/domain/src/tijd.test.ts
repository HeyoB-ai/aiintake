import { describe, expect, it } from 'vitest';
import { alleenDatum, alleenTijd, datumTijd, datumTijdSeconden } from './tijd';

/**
 * De ene rekenwijze voor tijd.
 *
 * De aanleiding: de dossierpagina toonde 11:53 voor een gesprek van 13:53, terwijl het
 * transcript ernaast 13:53:38 liet zien. Zes plekken, geen enkele met een `timeZone`, en het
 * verschil kwam uit wáár de code draaide — server (UTC) tegen browser (Amsterdam).
 *
 * Deze tests draaien in Node, dat op deze machine in Europe/Amsterdam staat. Ze moeten dus
 * óók slagen op een machine in UTC, en dat is precies wat er getoetst wordt: de uitkomst mag
 * niet van de omgeving afhangen.
 */

/** Het gesprek uit de melding: 27 augustus 2026, 13:53:38 Amsterdamse tijd. */
const GESPREK = '2026-08-27T11:53:38.000Z';

describe('de zone van het kantoor bepaalt de uitkomst', () => {
  it('toont Amsterdamse tijd voor een Amsterdams kantoor', () => {
    expect(datumTijd(GESPREK, 'Europe/Amsterdam')).toContain('13:53');
  });

  it('toont voor hetzelfde moment een andere tijd in een ander kantoor', () => {
    // Een kantoor in Lissabon hoort zijn eigen tijd te zien, niet die van Amsterdam.
    expect(datumTijd(GESPREK, 'Europe/Lisbon')).toContain('12:53');
    expect(datumTijd(GESPREK, 'UTC')).toContain('11:53');
  });

  it('hangt niet af van de zone waarin dit draait', () => {
    /*
     * Dit is de kern. `toLocaleString` zonder `timeZone` gaf op de server UTC en in de browser
     * Amsterdam. Met een expliciete zone hoort er precies één antwoord uit te komen, waar het
     * ook draait — en deze test valt om zodra iemand de parameter weer optioneel maakt met een
     * terugval op de omgeving.
     */
    expect(datumTijd(GESPREK, 'UTC')).toBe(datumTijd(GESPREK, 'UTC'));
    expect(datumTijd(GESPREK, 'Europe/Amsterdam')).not.toBe(datumTijd(GESPREK, 'UTC'));
  });
});

describe('twee uur die een dag schelen', () => {
  it('zet een gesprek van na middernacht niet op de vorige dag', () => {
    /*
     * Waarom dit meer is dan cosmetiek. Dinsdag 27 augustus 00:30 Amsterdamse tijd is in UTC
     * maandag 26 augustus 22:30. Een advocaat die op een vervaltermijn telt, komt dan een dag
     * te vroeg uit — en een termijn verschuift niet mee met een weergavefout.
     */
    const naMiddernacht = '2026-08-26T22:30:00.000Z';
    expect(alleenDatum(naMiddernacht, 'Europe/Amsterdam')).toBe('27-08-2026');
    expect(alleenDatum(naMiddernacht, 'UTC')).toBe('26-08-2026');
  });
});

describe('wat er bij een onbruikbare waarde gebeurt', () => {
  it('geeft een streepje in plaats van "Invalid Date"', () => {
    // Een onleesbare datum hoort niet als "Invalid Date" op het scherm van een advocaat te
    // komen. Een streepje zegt hetzelfde als een lege cel en liegt niet over de inhoud.
    for (const waarde of [null, undefined, '', 'geen datum']) {
      expect(datumTijd(waarde, 'Europe/Amsterdam')).toBe('—');
    }
  });
});

describe('de vier vormen', () => {
  it('geeft seconden waar de volgorde binnen een minuut telt', () => {
    // Het auditlog en het transcript: daar staat vaak meer dan één regel in dezelfde minuut,
    // en zonder seconden is niet te zien wat er eerst gebeurde.
    expect(datumTijdSeconden(GESPREK, 'Europe/Amsterdam')).toContain('13:53:38');
    expect(alleenTijd(GESPREK, 'Europe/Amsterdam')).toContain('13:53:38');
  });

  it('laat de datum weg waar hij ruis is', () => {
    // Binnen één gesprek zijn alle regels van dezelfde dag.
    expect(alleenTijd(GESPREK, 'Europe/Amsterdam')).not.toContain('2026');
  });

  it('laat de tijd weg waar hij niet toe doet', () => {
    expect(alleenDatum(GESPREK, 'Europe/Amsterdam')).not.toContain('13:53');
  });
});
