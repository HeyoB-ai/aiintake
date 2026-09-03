import { describe, expect, it } from 'vitest';
import {
  controleerContact,
  geldigEmail,
  geldigTelefoon,
  normaliseerTelefoon,
} from './contactgegevens';

/**
 * De regel die het formulier en de server allebei gebruiken.
 *
 * Aanleiding: een ongeldig e-mailadres op een iPhone leverde "Het gesprek kon niet worden
 * gestart" op — de melding die ook bij een databasestoring verschijnt. De cliënt dacht dat de
 * app stuk was, en de oorzaak stond alleen in het functielog.
 *
 * Het zwaartepunt ligt bij de telefoonnummers, want daar zit het echte risico: een formulier
 * dat mensen wegstuurt omdat ze spaties gebruiken.
 */

describe('telefoonnummers zoals mensen ze schrijven', () => {
  it('accepteert de Nederlandse notaties', () => {
    for (const nummer of [
      '0612345678',
      '06 12 34 56 78',
      '06-12345678',
      '06 12345678',
      '+31612345678',
      '+31 6 12345678',
      '0031612345678',
      // Staat zo op vrijwel elk Nederlands briefpapier: de landcode én de nul.
      '+31 (0)6 12345678',
      '+31(0)612345678',
      // Vaste nummers zijn net zo lang: netnummer plus abonneenummer is tien cijfers.
      '010-1234567',
      '020 123 4567',
      '0123 456789',
    ]) {
      expect(geldigTelefoon(nummer), nummer).toBe(true);
    }
  });

  it('accepteert een buitenlands nummer', () => {
    // Een grensarbeider heeft een Belgisch of Duits nummer. Weigeren zou hem wegsturen bij
    // het enige veld waarmee het kantoor hem kan bereiken.
    for (const nummer of ['+32 470 12 34 56', '+49 151 12345678', '+44 7700 900123']) {
      expect(geldigTelefoon(nummer), nummer).toBe(true);
    }
  });

  it('weigert wat geen nummer is', () => {
    for (const nummer of [
      '06123456',        // te kort
      '06123456789012',  // te lang
      '1612345678',      // Nederlands zonder de nul
      'nul zes twaalf',
      '06 1234 abcd',
      '+',
      '++31612345678',
      '+0612345678',     // geen landcode begint met een nul
    ]) {
      expect(geldigTelefoon(nummer), nummer).toBe(false);
    }
  });

  it('haalt de opmaak eruit zonder cijfers te verliezen', () => {
    expect(normaliseerTelefoon('06 12 34 56 78')).toBe('0612345678');
    expect(normaliseerTelefoon('+31 (0)6 12345678')).toBe('+31612345678');
    expect(normaliseerTelefoon('0031612345678')).toBe('+31612345678');
    expect(normaliseerTelefoon('06/12345678')).toBe('0612345678');
  });
});

describe('e-mailadressen', () => {
  it('accepteert gewone adressen', () => {
    for (const adres of [
      'jan@voorbeeld.nl',
      'jan.de.vries@voorbeeld.co.uk',
      'jan+werk@voorbeeld.nl',
      "o'brien@voorbeeld.ie",
      'JAN@VOORBEELD.NL',
    ]) {
      expect(geldigEmail(adres), adres).toBe(true);
    }
  });

  it('weigert wat de database ook zou weigeren', () => {
    /*
     * Dit is de kern. `create_public_intake` toetst met `not like '%_@_%.__%'`. Laat het
     * formulier iets door dat de database weigert, dan krijgt de cliënt alsnog de algemene
     * foutmelding — en dan is de veldvalidatie niets waard.
     */
    for (const adres of [
      'jan',
      'jan@',
      '@voorbeeld.nl',
      'jan@voorbeeld',   // geen punt in het domein
      'jan@voorbeeld.n', // tld van één teken
      'jan @voorbeeld.nl',
      'jan@voor beeld.nl',
      'jan@@voorbeeld.nl',
    ]) {
      expect(geldigEmail(adres), adres).toBe(false);
    }
  });
});

describe('welk veld de melding krijgt', () => {
  const goed = { naam: 'Jan de Vries', email: '', telefoon: '' };

  it('wijst de fout aan het veld waar hij zit', () => {
    expect(controleerContact({ ...goed, email: 'jan@voorbeeld' })?.veld).toBe('clientEmail');
    expect(controleerContact({ ...goed, telefoon: '06123' })?.veld).toBe('clientPhone');
    expect(controleerContact({ ...goed, naam: 'J' })?.veld).toBe('clientName');
  });

  it('noemt bij een telefoonnummer wat er dan wél mag', () => {
    // "Ongeldig" laat iemand raden. Op een telefoon met een half formulier is dat het moment
    // waarop hij afhaakt.
    expect(controleerContact({ ...goed, telefoon: '06123' })?.melding).toContain('06 12345678');
  });

  it('laat lege contactvelden met rust', () => {
    /*
     * Contactgegevens zijn optioneel; dat staat als mededeling op het scherm. Een leeg veld
     * is iets anders dan een verkeerd ingevuld veld, en het als fout tonen zou de cliënt
     * tegenhouden bij iets dat mag.
     */
    expect(controleerContact(goed)).toBeNull();
  });

  it('geeft één fout tegelijk, in de volgorde van het formulier', () => {
    // Drie rode regels onder elkaar lezen als een formulier dat je niet goed kunt invullen.
    const fout = controleerContact({ naam: 'J', email: 'kapot', telefoon: '06123' });
    expect(fout?.veld).toBe('clientName');
  });

  it('laat een volledig correcte invoer door', () => {
    // Anders bewaakt de rest niets: een controle die alles weigert, zou ook slagen.
    expect(
      controleerContact({
        naam: 'Jan de Vries',
        email: 'jan@voorbeeld.nl',
        telefoon: '+31 (0)6 12345678',
      }),
    ).toBeNull();
  });
});
