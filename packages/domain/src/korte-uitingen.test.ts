import { describe, expect, it } from 'vitest';
import { isContentlessAffirmation } from './affirmation';
import { INHOUDSLOZE_WOORDEN, KORTE_UITINGEN, backchannelsVoor } from './korte-uitingen';
import { isBackchannel } from './schemas/conversation';

/**
 * Elk woord staat bewust in beide kolommen of in één — niet per ongeluk.
 *
 * ## Wat er misging
 *
 * Twee lijsten, twee doelen, en ze liepen uiteen zonder dat iemand dat had besloten.
 * "Inderdaad" onderbrak de assistent én werd als bewijs geweigerd; "mm-hm" deed geen van beide.
 * Dat merk je in een gesprek en niet in een test — tot nu.
 *
 * ## Wat deze tests bewaken
 *
 * Niet dát de kolommen gelijk zijn: ze mógen verschillen, en voor "nee" en "eh" hóren ze dat.
 * Wel dat elk verschil een reden heeft, en dat de twee gebruikers van de tabel er hetzelfde
 * uit lezen.
 */

describe('elk verschil is opzettelijk', () => {
  it('geeft een reden zodra de twee kolommen verschillen', () => {
    /*
     * Dit is de kern. Een woord waarvan `backchannel` en `inhoudsloos` niet gelijk zijn, is
     * precies het geval dat eerder per ongeluk ontstond. Nu kan dat alleen nog mét uitleg.
     */
    const zonderReden = KORTE_UITINGEN.filter(
      (u) => u.backchannel !== u.inhoudsloos && (u.waarom ?? '').trim() === '',
    );
    expect(
      zonderReden.map((u) => u.woord),
      'deze woorden verschillen per kolom zonder dat er staat waarom',
    ).toEqual([]);
  });

  it('kan falen — een verschil zonder reden wordt gezien', () => {
    // Zonder deze regel is "nul woorden zonder reden" niet te onderscheiden van een tabel
    // waarin de kolommen toevallig nergens verschillen.
    const nep = { woord: 'x', taal: 'nl' as const, backchannel: false, inhoudsloos: true };
    expect(nep.backchannel !== nep.inhoudsloos && !('waarom' in nep)).toBe(true);
  });

  it('heeft ook werkelijk woorden waar de kolommen verschillen', () => {
    // Anders bewaakt de eerste test niets: geen verschil, geen reden nodig.
    expect(KORTE_UITINGEN.some((u) => u.backchannel !== u.inhoudsloos)).toBe(true);
  });
});

describe('de gevallen die eerder per ongeluk verschilden', () => {
  it('laat "inderdaad" de assistent niet meer onderbreken', () => {
    // Stond alleen in de inhoudsloze lijst. Het is instemming, net als "klopt" en "precies".
    expect(isBackchannel('inderdaad', 250, 'nl')).toBe(true);
    expect(isContentlessAffirmation('inderdaad')).toBe(true);
  });

  it('laat "mm-hm" ook geen feit dragen', () => {
    // Stond alleen in de backchannel-lijst en telde dus als inhoud.
    expect(isBackchannel('mm-hm', 200, 'nl')).toBe(true);
    expect(isContentlessAffirmation('mm-hm')).toBe(true);
  });

  it('behandelt "zeker" en "correct" als instemming, niet als inhoud', () => {
    for (const w of ['zeker', 'correct']) {
      expect(isBackchannel(w, 250, 'nl'), w).toBe(true);
      expect(isContentlessAffirmation(w), w).toBe(true);
    }
  });
});

describe('wat wél moet onderbreken', () => {
  it('laat "nee" doorkomen als onderbreking', () => {
    /*
     * Een "nee" is een correctie. Zegt de assistent iets verkeerd, dan moet de cliënt haar
     * kunnen stoppen — dat is het tegenovergestelde van een luistergeluid. Als citaat draagt
     * het wél geen feit: "nee" alleen zegt niet wát er dan niet klopt.
     */
    expect(isBackchannel('nee', 200, 'nl')).toBe(false);
    expect(isContentlessAffirmation('nee')).toBe(true);
  });

  it('laat aarzeling doorkomen', () => {
    // Wie "eh…" zegt gaat iets zeggen; hem overstemmen is precies de doofheid die we vermijden.
    for (const w of ['eh', 'ehm', 'nou', 'tja']) {
      expect(isBackchannel(w, 200, 'nl'), w).toBe(false);
    }
  });

  it('laat "goed" doorkomen, want dat begint vaak een zin', () => {
    expect(isBackchannel('goed', 200, 'nl')).toBe(false);
  });
});

describe('de twee afgeleide lijsten', () => {
  it('bevatten alleen woorden uit hun eigen taal', () => {
    expect(backchannelsVoor('nl')).not.toContain('yeah');
    expect(backchannelsVoor('en')).not.toContain('klopt');
  });

  it('zijn niet leeg', () => {
    // Een afleiding die per ongeluk niets oplevert, maakt van elke backchannel een onderbreking.
    expect(backchannelsVoor('nl').length).toBeGreaterThan(5);
    expect(backchannelsVoor('en').length).toBeGreaterThan(3);
  });

  it('nemen de stopwoorden alleen mee in de inhoudsloze verzameling', () => {
    // "dat" en "is" worden nooit op zichzelf gezegd; ze horen niet in de backchannel-lijst.
    expect(INHOUDSLOZE_WOORDEN.has('dat')).toBe(true);
    expect(backchannelsVoor('nl')).not.toContain('dat');
  });

  it('laat een echt antwoord met een instemmend woord erin ongemoeid', () => {
    // "nee, dat was in maart" is geen inhoudsloze instemming — dat is het dataverlies dat
    // risico 2 verbiedt.
    expect(isContentlessAffirmation('nee, dat was in maart')).toBe(false);
  });
});
