import { describe, expect, it } from 'vitest';
import { ALLE_HERVATTINGSZINNEN, hervattingsZin } from './hervatting';

/**
 * De tweede opening. Deze tests bewaken vooral wat er níét in staat.
 *
 * De verleiding is om te hervatten mét inhoud — "u vertelde net dat u ontslagen bent" —
 * en dat is precies wat niet mag: er staat op dat moment nog niets in het dossier, en een
 * verwijzing wekt de indruk van wel.
 */

describe('wat er in staat', () => {
  it('spreekt de cliënt aan met groet en naam', () => {
    const zin = hervattingsZin({ greeting: 'Goedemiddag', clientName: 'Sanne de Vries' });
    expect(zin).toContain('Goedemiddag, Sanne de Vries.');
    expect(zin).toContain('verder waar we gebleven waren');
  });

  it('laat de groet weg midden in de nacht, maar houdt de naam', () => {
    const zin = hervattingsZin({ greeting: null, clientName: 'Sanne de Vries' });
    expect(zin.startsWith('Sanne de Vries.')).toBe(true);
  });

  it('verzint geen naam als die er niet is', () => {
    const zin = hervattingsZin({ greeting: 'Goedemiddag', clientName: null });
    expect(zin).toBe('We gaan verder waar we gebleven waren.');
  });
});

describe('wat er niet in staat', () => {
  it('stelt geen vraag', () => {
    // "Waar waren we gebleven?" is een vraag, en de vraag is aan de planner. Twee vragen
    // in één beurt is wat de gespreksvorm verbiedt.
    for (const zin of ALLE_HERVATTINGSZINNEN) expect(zin).not.toContain('?');
  });

  it('belooft niets over wat er is vastgelegd', () => {
    for (const zin of ALLE_HERVATTINGSZINNEN) {
      const k = zin.toLowerCase();
      for (const woord of [
        'vertelde',
        'besproken',
        'genoteerd',
        'vastgelegd',
        'dossier',
        'told me',
        'recorded',
      ]) {
        expect(k).not.toContain(woord);
      }
    }
  });

  it('herhaalt de AI-mededeling niet', () => {
    for (const zin of ALLE_HERVATTINGSZINNEN) {
      expect(zin.toLowerCase()).not.toContain('ai-');
      expect(zin.toLowerCase()).not.toContain('advocaat');
    }
  });

  it('veronderstelt niet dat weggaan vrijwillig was', () => {
    // Iemand met een haperende verbinding is niet weggeweest, die is eruit gegooid.
    for (const zin of ALLE_HERVATTINGSZINNEN) {
      expect(zin.toLowerCase()).not.toContain('fijn dat u er weer');
      expect(zin.toLowerCase()).not.toContain('welkom terug');
    }
  });

  it('blijft kort', () => {
    for (const zin of ALLE_HERVATTINGSZINNEN) expect(zin.length).toBeLessThan(70);
  });
});
