import { describe, expect, it } from 'vitest';
import { isContentlessAffirmation } from './affirmation';

describe('instemming zonder inhoud', () => {
  it('herkent een kale bevestiging', () => {
    for (const q of ['Ja.', 'ja', 'Klopt.', 'Inderdaad!', 'Ja, klopt.', 'Eh, ja.', '']) {
      expect(isContentlessAffirmation(q), q).toBe(true);
    }
  });

  it('laat een antwoord mét inhoud met rust', () => {
    // "nee, dat was in maart" is geen inhoudsloze instemming — dat wegvangen zou het
    // dataverlies zijn dat risico 2 verbiedt.
    for (const q of [
      'Nee, dat was in maart.',
      'Ja, op 17 januari.',
      'Klopt, bij Acme Nederland.',
      'Ik werk daar sinds 2019.',
    ]) {
      expect(isContentlessAffirmation(q), q).toBe(false);
    }
  });
});
