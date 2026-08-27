import { describe, expect, it } from 'vitest';
import { laatsteVraag } from '@intake/domain';
import { SentenceFlusher } from './sentence-flush';

/**
 * Twee regels voor "waar eindigt een zin", en ze horen te verschillen.
 *
 * ## Waarom dit een test is en geen toelichting
 *
 * Er zijn twee zinsgrensregels in deze repo:
 *
 *   `SentenceFlusher` — flusht op elke `.`, `?` of `!`, zonder verdere eisen.
 *   `laatsteVraag()`  — eist witruimte plus een hoofdletter of cijfer erna.
 *
 * Ze zien er verwisselbaar uit en dat zijn ze niet. Wie ze "opruimt" tot één functie, breekt
 * er één van, en welke hangt af van welke kant hij kiest. Een toelichting die dat uitlegt, is
 * geen bewaker; deze test wel.
 *
 * ## Waarom de flusher gretig moet zijn
 *
 * Hij zit op het spraakpad. Een gemiste flush kost honderden milliseconden stilte; een te
 * vroege flush kost een minieme pauze midden in een zin. Die asymmetrie bepaalt de keuze — dat
 * staat zo in `sentence-flush.ts` en het klopt.
 *
 * ## Waarom de vraagscheider dat juist niet mag zijn
 *
 * Hij zit op het scherm. Splitst hij op "2.500 euro" of "bijv.", dan staat er een halve zin
 * boven de video als "de vraag" — en dat vak bestaat juist voor wie de vraag niet verstond.
 * Daar kost een fout geen milliseconden maar begrip.
 */

/** Wat de flusher zou wegsturen voor een gegeven tekst. */
function flushes(tekst: string): string[] {
  const uit: string[] = [];
  const f = new SentenceFlusher((zin) => uit.push(zin));
  f.push(tekst);
  f.end();
  return uit;
}

describe('de flusher is gretig, en dat hoort zo', () => {
  it('knipt op een afkorting, en dat is de bedoeling', () => {
    // Kosten: een minieme pauze na "bijv.". Baten: nooit wachten op het einde van een beurt.
    const uit = flushes('Denk bijv. aan een vaststellingsovereenkomst.');
    expect(uit.length).toBeGreaterThan(1);
  });

  it('knipt op een bedrag met een punt', () => {
    const uit = flushes('U noemde 2.500 euro per maand.');
    expect(uit.length).toBeGreaterThan(1);
  });
});

describe('de vraagscheider is behoedzaam, en dat hoort óók zo', () => {
  it('knipt niet op dezelfde afkorting', () => {
    expect(laatsteVraag('Denk bijv. aan een vaststellingsovereenkomst. Heeft u die?')).toBe(
      'Heeft u die?',
    );
  });

  it('knipt niet op hetzelfde bedrag', () => {
    expect(laatsteVraag('U noemde 2.500 euro per maand. Klopt dat?')).toBe('Klopt dat?');
  });
});

describe('ze verschillen aantoonbaar, en dat is het punt', () => {
  it('geeft op dezelfde tekst een ander aantal stukken', () => {
    /*
     * Dit is de assertie die omvalt zodra iemand er één functie van maakt. Wie hem ziet falen
     * moet niet de test aanpassen maar de vraag beantwoorden: welke van de twee kanten heb ik
     * zojuist gekozen, en wat kost dat aan de andere kant?
     */
    const tekst = 'Denk bijv. aan een VSO. Heeft u die?';
    const gretig = flushes(tekst).length;
    const behoedzaam = laatsteVraag(tekst);

    expect(gretig).toBeGreaterThan(2);
    // De behoedzame kant houdt "Denk bijv. aan een VSO." heel en levert alleen de vraag.
    expect(behoedzaam).toBe('Heeft u die?');
  });
});
