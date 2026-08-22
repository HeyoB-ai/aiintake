import { describe, expect, it } from 'vitest';
import { SentenceFlusher } from './sentence-flush';

/**
 * Zinsgewijs flushen is na "geen JSON op het hot path" de grootste latencywinst in de
 * lus. Modellen leveren grillige fragmenten aan — een zinseinde midden in een fragment,
 * of drie zinnen in één keer — dus dat is waar deze tests op mikken.
 */

function collect(chunks: string[], maxChars?: number): string[] {
  const out: string[] = [];
  const flusher = new SentenceFlusher((s) => out.push(s), maxChars);
  for (const chunk of chunks) flusher.push(chunk);
  flusher.end();
  return out;
}

describe('zinsgewijs flushen', () => {
  it('flusht op punt, vraagteken en uitroepteken', () => {
    expect(collect(['Eén. Twee? Drie!'])).toEqual(['Eén.', 'Twee?', 'Drie!']);
  });

  it('werkt als het zinseinde midden in een fragment valt', () => {
    // Zo levert een echt model het aan: niet netjes op zinsgrenzen.
    expect(collect(['Dank u we', 'l. Wanneer kree', 'g u hem?'])).toEqual([
      'Dank u wel.',
      'Wanneer kreeg u hem?',
    ]);
  });

  it('flusht letter voor letter net zo goed als in grote brokken', () => {
    const zin = 'Heeft u al getekend?';
    expect(collect([...zin])).toEqual([zin]);
    expect(collect([zin])).toEqual([zin]);
  });

  it('stuurt de rest weg bij end(), ook zonder afsluitend leesteken', () => {
    expect(collect(['Nog een losse zin zonder punt'])).toEqual(['Nog een losse zin zonder punt']);
  });

  it('kapt af op de tekengrens als er geen leesteken komt', () => {
    // Zonder deze grens blijft een lange bijzin zonder interpunctie hangen tot het
    // einde van de beurt, en dan is de winst van flushen weg.
    const lang =
      'a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(30) + ' ' + 'd'.repeat(30);
    const out = collect([lang], 40);
    expect(out.length).toBeGreaterThan(1);
    expect(out.join(' ')).toBe(lang);
  });

  it('knipt alleen op een spatie, nooit midden in een woord', () => {
    const out = collect(['woordje '.repeat(20)], 30);
    for (const zin of out) {
      expect(zin).not.toMatch(/woordj$|woord$|woor$/);
    }
  });

  it('geeft geen lege zinnen door', () => {
    expect(collect(['...', '   ', '.'])).not.toContain('');
    expect(collect(['   '])).toEqual([]);
  });

  it('discard() gooit weg wat de cliënt nog niet gehoord heeft', () => {
    const out: string[] = [];
    const flusher = new SentenceFlusher((s) => out.push(s));
    flusher.push('Eerste zin. En dan begint de tw');
    expect(out).toEqual(['Eerste zin.']);

    // Barge-in: de halve tweede zin is nooit naar de TTS gegaan en mag ook niet
    // alsnog via end() naar buiten glippen.
    flusher.discard();
    flusher.end();
    expect(out).toEqual(['Eerste zin.']);
  });
});
