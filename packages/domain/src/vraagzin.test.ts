import { describe, expect, it } from 'vitest';
import { inZinnen, laatsteVraag } from './vraagzin';

/**
 * De vraag scheiden van de rest van de beurt.
 *
 * Aanleiding: op het cliëntscherm stond de hele beurt boven het transcript. Bij de opening zijn
 * dat vier zinnen — groet, wie ze is, de disclaimer, de vraag — en die stonden daarna ook in de
 * lijst eronder. Wat er bovenaan hoort te staan is wat er gevráágd is.
 */

/** De openingsbeurt zoals hij in productie klinkt. */
const OPENING =
  'Goedenavond, Heyo Beentje. Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht. ' +
  'Ik ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen. ' +
  'Kunt u vertellen wat er speelt en waarom u contact opneemt?';

describe('de opening', () => {
  it('levert alleen de vraag, niet de vier zinnen ervoor', () => {
    expect(laatsteVraag(OPENING)).toBe(
      'Kunt u vertellen wat er speelt en waarom u contact opneemt?',
    );
  });

  it('laat de disclaimer niet in de vraag belanden', () => {
    // Die hoort in het transcript en niet bovenaan: bovenaan staat wat er gevraagd is.
    expect(laatsteVraag(OPENING)).not.toContain('advocaat');
    expect(laatsteVraag(OPENING)).not.toContain('Goedenavond');
  });

  it('knipt de opening in vier zinnen en verliest er geen', () => {
    const zinnen = inZinnen(OPENING);
    expect(zinnen).toHaveLength(4);
    // Alles bij elkaar is weer de hele beurt: er gaat niets verloren, het wordt alleen
    // gescheiden. Het transcript toont de volledige tekst.
    expect(zinnen.join(' ')).toBe(OPENING);
  });
});

describe('wat er niet mag splitsen', () => {
  it('splitst niet op een bedrag', () => {
    const beurt = 'U noemde een bedrag van 2.500 euro. Klopt dat bedrag?';
    expect(inZinnen(beurt)).toHaveLength(2);
    expect(laatsteVraag(beurt)).toBe('Klopt dat bedrag?');
  });

  it('splitst niet op een afkorting met een kleine letter erna', () => {
    const beurt = 'Denk bijv. aan een vaststellingsovereenkomst. Heeft u zoiets ontvangen?';
    expect(inZinnen(beurt)).toHaveLength(2);
    expect(laatsteVraag(beurt)).toBe('Heeft u zoiets ontvangen?');
  });

  it('splitst niet op een datum met punten', () => {
    const beurt = 'U zei 17.03.2026 als datum. Klopt dat?';
    expect(laatsteVraag(beurt)).toBe('Klopt dat?');
  });
});

describe('beurten zonder vraag', () => {
  it('valt terug op de laatste zin bij de afronding', () => {
    // De afronding stelt met opzet geen vraag. Dan is de mededeling wat er te lezen valt, en
    // een leeg vak zou erger zijn dan een zin die geen vraagteken heeft.
    const afronding =
      'Ik heb genoeg om mee verder te kunnen. Een advocaat kijkt hiernaar en neemt contact op.';
    expect(laatsteVraag(afronding)).toBe('Een advocaat kijkt hiernaar en neemt contact op.');
  });

  it('geeft een lege tekst terug bij niets', () => {
    expect(laatsteVraag('')).toBe('');
    expect(laatsteVraag('   ')).toBe('');
  });

  it('laat een beurt van één zin heel', () => {
    expect(laatsteVraag('Wanneer is dat gebeurd?')).toBe('Wanneer is dat gebeurd?');
  });
});

describe('meer dan één vraag', () => {
  it('neemt de laatste, want daarop wordt geantwoord', () => {
    /*
     * De prompt verbiedt twee vragen in één beurt. Dit dekt wat er gebeurt als het model zich
     * daar niet aan houdt: dan is de laatste vraag degene die de cliënt in gedachten heeft, en
     * de eerste toont zou hem het verkeerde laten nalezen.
     */
    const beurt = 'Wanneer was dat? En weet u nog wie dat zei?';
    expect(laatsteVraag(beurt)).toBe('En weet u nog wie dat zei?');
  });
});

describe('rommelige invoer', () => {
  it('normaliseert witruimte en regeleindes', () => {
    const beurt = 'Ik ben geen advocaat.\n\n  Kunt u vertellen   wat er speelt?';
    expect(laatsteVraag(beurt)).toBe('Kunt u vertellen wat er speelt?');
  });

  it('laat een erkenning vooraan buiten de vraag', () => {
    // De erkenning wordt als eigen bericht weggeschreven maar loopt op de WS in dezelfde
    // beurttekst mee. Bovenaan hoort alleen de vraag.
    const beurt = 'Dus u bent in februari ziek gemeld. Hoe lang bent u toen thuis geweest?';
    expect(laatsteVraag(beurt)).toBe('Hoe lang bent u toen thuis geweest?');
  });
});
