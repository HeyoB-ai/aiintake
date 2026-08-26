import { describe, expect, it } from 'vitest';
import { gegevensCompleet } from './scherm-toestemming';

/**
 * De poort vóór het gesprek.
 *
 * Deze regel bestaat twee keer met opzet: hier als gemak voor wie het formulier invult, en
 * in `create_public_intake` als grens. Wat hier wordt getoetst is uitsluitend de eerste —
 * dat de knop niet opengaat zonder naam. Of de database hem óók weigert, is een andere
 * bewering, en die staat in de migratie.
 *
 * Contactgegevens zijn bewust géén voorwaarde. Er stond één dag lang "naam plus e-mail óf
 * telefoon" in, terwijl beide velden het label "(optioneel)" droegen; die tegenspraak is
 * opgelost door de eis te laten vallen. De tests hieronder leggen dat vast, zodat het niet
 * per ongeluk terugkomt.
 */
describe('gegevensCompleet', () => {
  it('weigert een lege naam', () => {
    expect(gegevensCompleet('')).toBe(false);
  });

  it('telt witruimte niet als invulling', () => {
    // Een veld dat is aangeraakt en weer leeggemaakt levert vaak een spatie op. Zonder
    // trimmen gaat de knop dan open en weigert de database pas ná het toestemmingsscherm.
    expect(gegevensCompleet('   ')).toBe(false);
  });

  it('weigert een naam van één teken', () => {
    // Niet omdat één letter onmogelijk is, maar omdat het vrijwel altijd een typefout of
    // een test is. De grens ligt gelijk met die in create_public_intake.
    expect(gegevensCompleet('S')).toBe(false);
  });

  it('accepteert een naam', () => {
    expect(gegevensCompleet('Sanne de Vries')).toBe(true);
  });

  it('accepteert een naam zonder enig contactkanaal', () => {
    // Het punt van deze test. De knop hoort open te gaan met alleen een naam; er kan dus
    // een dossier binnenkomen waar het kantoor niemand over kan bellen. Dat is een
    // toegestane toestand en geen omissie — het scherm meldt het aan de cliënt.
    expect(gegevensCompleet('Sanne de Vries')).toBe(true);
  });
});
