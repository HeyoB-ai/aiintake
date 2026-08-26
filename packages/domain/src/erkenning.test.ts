import { describe, expect, it } from 'vitest';
import {
  ALLE_ERKENNINGEN,
  ERKENNING_MARKERING,
  MIN_BEURTEN_TUSSEN_ERKENNINGEN,
  kiesErkenning,
  type ErkenningStand,
} from './erkenning';

const LEEG: ErkenningStand = { gebruikt: [], laatsteBeurt: null };

describe('selectiviteit', () => {
  it('zwijgt bij een uitspraak zonder lading', () => {
    // "Mijn contract begon in maart 2023" hoort niets op te leveren.
    expect(kiesErkenning('geen', 3, LEEG)).toEqual({ zin: null, reden: 'geen lading' });
  });

  it('erkent bij persoonlijke lading', () => {
    expect(kiesErkenning('persoonlijk', 3, LEEG).zin).toBeTruthy();
  });

  it('kiest een andere toon bij zware lading', () => {
    const licht = kiesErkenning('persoonlijk', 3, LEEG).zin;
    const zwaar = kiesErkenning('zwaar', 3, LEEG).zin;
    expect(zwaar).not.toBe(licht);
  });
});

describe('geen herhaling', () => {
  it('gebruikt een zin hoogstens één keer per gesprek', () => {
    const eerste = kiesErkenning('zwaar', 0, LEEG).zin!;
    const tweede = kiesErkenning('zwaar', 5, { gebruikt: [eerste], laatsteBeurt: 0 }).zin;
    expect(tweede).toBeTruthy();
    expect(tweede).not.toBe(eerste);
  });

  it('zwijgt als alle zinnen op zijn', () => {
    // Drie keer "wat vervelend om te horen" is erger dan zwijgen; op is op.
    const alles = [
      kiesErkenning('zwaar', 0, LEEG).zin!,
      kiesErkenning('zwaar', 3, { gebruikt: [], laatsteBeurt: null }).zin!,
    ];
    const stand: ErkenningStand = {
      gebruikt: ALLE_ERKENNINGEN.slice(),
      laatsteBeurt: 0,
    };
    expect(kiesErkenning('zwaar', 99, stand)).toEqual({ zin: null, reden: 'zinnen op' });
    expect(alles.length).toBe(2);
  });

  it('laat minstens twee beurten tussen twee erkenningen', () => {
    const stand: ErkenningStand = { gebruikt: [], laatsteBeurt: 4 };
    expect(kiesErkenning('zwaar', 5, stand).reden).toBe('te snel na de vorige');
    expect(kiesErkenning('zwaar', 4 + MIN_BEURTEN_TUSSEN_ERKENNINGEN, stand).zin).toBeTruthy();
  });
});

describe('de drie grenzen, afgedwongen door de zinnen zelf', () => {
  /*
   * Grens 1: nooit de juridische merites erkennen.
   *
   * "Dat is vervelend om te horen" mag; "dat klinkt als onterecht ontslag" is juridisch
   * advies en breekt de belofte op het toestemmingsscherm. Deze test dekt niet elke
   * denkbare formulering af — hij dekt af dat er geen oordeelwoorden in de lijst staan, en
   * de lijst is de enige bron van erkenningszinnen.
   */
  const OORDEEL = [
    'onterecht',
    'terecht',
    'onrechtmatig',
    'kansrijk',
    'sterk',
    'zwakke zaak',
    'recht op',
    'illegal',
    'unfair',
    'wrongful',
    'entitled',
  ];

  it('bevat geen oordeel over de zaak', () => {
    for (const zin of ALLE_ERKENNINGEN) {
      for (const woord of OORDEEL) {
        expect(zin.toLowerCase()).not.toContain(woord);
      }
    }
  });

  /*
   * Grens 3: nooit een gevoel benoemen dat de cliënt niet heeft geuit.
   *
   * "Dat moet u boos hebben gemaakt" is een aanname. De zinnen gaan over de gebeurtenis,
   * niet over de persoon: "dat is schrikken" zegt niet dat de cliënt geschrokken ís.
   */
  const GEVOEL = ['boos', 'bang', 'verdrietig', 'gefrustreerd', 'angry', 'sad', 'upset'];

  it('benoemt geen gevoel van de cliënt', () => {
    for (const zin of ALLE_ERKENNINGEN) {
      for (const woord of GEVOEL) {
        expect(zin.toLowerCase()).not.toContain(woord);
      }
    }
  });

  it('stelt geen vraag', () => {
    // De vraag komt van de planner. Twee vragen in één beurt is precies wat de
    // gespreksvorm verbiedt.
    for (const zin of ALLE_ERKENNINGEN) {
      expect(zin).not.toContain('?');
    }
  });

  it('blijft één korte zin', () => {
    for (const zin of ALLE_ERKENNINGEN) {
      expect(zin.length).toBeLessThan(45);
      expect(zin.split('.').filter((d) => d.trim()).length).toBe(1);
    }
  });

  /*
   * Grens 2: nooit als bron voor feitextractie tellen.
   *
   * De markering is het leesbare slot. Het tweede slot is dat de beurt als `assistant` in
   * het transcript staat, en assistent-beurten zijn al uitgesloten van extractie. Deze test
   * legt alleen vast dat de markering bestaat en herkenbaar is; de uitsluiting zelf wordt
   * getoetst waar hij wordt afgedwongen.
   */
  it('heeft een herkenbare markering voor het transcript', () => {
    expect(ERKENNING_MARKERING.trim().startsWith('[')).toBe(true);
    expect(ERKENNING_MARKERING).toContain('erkenning');
  });
});

describe('taal', () => {
  it('geeft Engelse zinnen in het Engels', () => {
    const zin = kiesErkenning('zwaar', 3, LEEG, 'en').zin!;
    expect(zin).toMatch(/^[A-Z]/);
    expect(zin).not.toContain('Dat');
  });
});
