import { describe, expect, it } from 'vitest';
import { ALLE_OPENINGSZINNEN, openingsZin } from './opening';

/**
 * De opening ligt vast. Deze tests bewaken wát er in staat en wat er niet uit mag verdwijnen.
 *
 * Aanleiding: de opening kwam van het model, dat een sjabloon uit de prompt teken voor teken
 * reproduceerde — 338 tekens, ongeveer twintig seconden voordat de cliënt iets kon zeggen. Een
 * modelaanroep voor een vaste tekst kost latency, tokens, en een risico dat niets teruggeeft:
 * een model dat één keer níét reproduceert, zwakt de disclaimer af of laat hem weg.
 *
 * Nu de tekst vastligt, is de bewaking niet meer "hopen dat het model zich eraan houdt" maar
 * een test. Dat is het hele punt van de verplaatsing.
 */

const NORMAAL = openingsZin({
  greeting: 'Goedenavond',
  clientName: 'Heyo Beentje',
  organisationName: 'Van Dijk Arbeidsrecht',
});

describe('de vier mededelingen staan er in elke vorm in', () => {
  it('noemt zichzelf AI, letterlijk', () => {
    /*
     * "AI" moet er letterlijk in staan. Niet "intake-assistent", niet "digitale assistent":
     * een cliënt kan "assistent" horen als een mens die de intake doet, en dan is de
     * mededeling niet gedaan.
     */
    for (const zin of ALLE_OPENINGSZINNEN) {
      expect(zin, zin).toMatch(/\bAI[- ]/);
    }
  });

  it('zegt dat ze geen advocaat is', () => {
    // Dit is de zin waarvoor de cliënt op het toestemmingsscherm tekent. Zie risico 17.
    for (const zin of ALLE_OPENINGSZINNEN) {
      expect(zin.toLowerCase(), zin).toMatch(/geen advocaat|not a lawyer/);
    }
  });

  it('zegt dat ze geen juridisch advies geeft', () => {
    // Een tweede, andere mededeling. De een vervangt de ander niet.
    for (const zin of ALLE_OPENINGSZINNEN) {
      expect(zin.toLowerCase(), zin).toMatch(
        /geen juridisch advies|no legal advice|not give legal/,
      );
    }
  });

  it('eindigt met de open uitnodiging', () => {
    for (const zin of ALLE_OPENINGSZINNEN) {
      expect(zin.trimEnd().endsWith('?'), zin).toBe(true);
    }
  });
});

describe('de twee disclaimers staan los van elkaar', () => {
  it('plakt ze niet met "en" aan de taak vast', () => {
    /*
     * Het oude sjabloon deed dat wél: "Ik ben geen advocaat en ben aangesteld om de gegevens
     * van uw zaak vast te leggen". De regel eronder in diezelfde prompt verbood precies dat —
     * twee mededelingen die elk op zichzelf moeten landen, aan elkaar geplakt. Het sjabloon
     * overtrad zijn eigen regel.
     */
    expect(NORMAAL).toContain('Ik ben geen advocaat.');
    expect(NORMAAL).not.toMatch(/geen advocaat en/);
  });

  it('zet eerst wat ze doet en daarna pas wat ze niet doet', () => {
    // Een beperking is pas te plaatsen als iemand weet waar je voor bent. Andersom klinkt het
    // als een voorbehoud vooraf.
    expect(NORMAAL.indexOf('Ik leg de gegevens')).toBeLessThan(NORMAAL.indexOf('geen advocaat'));
  });
});

describe('de invulplekken', () => {
  it('gebruikt de naam van het kantoor precies één keer', () => {
    // Het oude sjabloon noemde hem twee keer, plus "uw zaak" twee keer. Dat was de helft van
    // wat er aan lengte af kon zonder een mededeling te schrappen.
    const voorkomens = NORMAAL.split('Van Dijk Arbeidsrecht').length - 1;
    expect(voorkomens).toBe(1);
  });

  it('neemt de naam van de cliënt letterlijk over', () => {
    expect(NORMAAL).toContain('Goedenavond, Heyo Beentje.');
  });

  it('groet zonder naam als die er niet is', () => {
    const zonder = openingsZin({
      greeting: 'Goedenavond',
      clientName: null,
      organisationName: 'X',
    });
    expect(zonder.startsWith('Goedenavond.')).toBe(true);
  });

  it('begint direct als er geen groet is', () => {
    // Midden in de nacht is er geen groet: "goedenacht" is een afscheid. Zie groet.ts.
    const zonder = openingsZin({ greeting: null, clientName: null, organisationName: 'X' });
    expect(zonder.startsWith('Ik ben de AI-intake-assistent')).toBe(true);
  });
});

describe('de lengte', () => {
  it('is korter dan het sjabloon dat het model reproduceerde', () => {
    /*
     * Het gemeten sjabloon was 338 tekens, ongeveer 19,5 seconde op het gemeten tempo van
     * 58 ms per teken. Deze test houdt vast dat de inkorting er is en niet stilletjes
     * terugkruipt bij een volgende formulering.
     *
     * Geen strakke bovengrens: een langere kantoornaam mag hem groter maken, en een test die
     * op één teken faalt wordt uitgezet in plaats van gerespecteerd.
     */
    expect(NORMAAL.length).toBeLessThan(300);
    expect(NORMAAL.length).toBeGreaterThan(200);
  });
});
