import { describe, expect, it } from 'vitest';
import { findArithmeticClaim, parseDutchNumber } from './arithmetic';

describe('Nederlandse getallen', () => {
  it('leest een punt als duizendtal en een komma als decimaal', () => {
    // Andersom lezen zou van 12.000 twaalf maken, en dan controleer je een som die
    // niemand heeft uitgesproken.
    expect(parseDutchNumber('12.000')).toBe(12000);
    expect(parseDutchNumber('140000')).toBe(140000);
    expect(parseDutchNumber('4.200,50')).toBe(4200.5);
    expect(parseDutchNumber('12,5')).toBe(12.5);
  });

  it('weigert wat geen Nederlands getal is', () => {
    expect(parseDutchNumber('12.00')).toBeNull(); // geen groep van drie
    expect(parseDutchNumber('twaalf')).toBeNull();
  });
});

describe('rekenkundige beweringen', () => {
  it('herkent de fout uit de live-sessie', () => {
    const c = findArithmeticClaim('Ze bieden twaalf maandsalarissen. 12 x 12000 is 140000.');
    expect(c).not.toBeNull();
    expect(c!.actual).toBe(144000);
    expect(c!.stated).toBe(140000);
    expect(c!.correct).toBe(false);
  });

  it('laat een kloppende som met rust', () => {
    const c = findArithmeticClaim('12 x 12.000 is 144.000');
    expect(c!.correct).toBe(true);
  });

  it('begrijpt "keer" en "maal" net zo goed als het maalteken', () => {
    expect(findArithmeticClaim('drie keer 1000 is 4000')).toBeNull(); // "drie" is geen cijfer
    expect(findArithmeticClaim('3 keer 1.000 is 4.000')!.correct).toBe(false);
    expect(findArithmeticClaim('3 maal 1.000 is 3.000')!.correct).toBe(true);
  });

  it('rekent optellen en aftrekken ook na', () => {
    expect(findArithmeticClaim('4.000 plus 500 is 4.400')!.correct).toBe(false);
    expect(findArithmeticClaim('4.000 min 500 is 3.500')!.correct).toBe(true);
  });

  it('rekent een cent afronding niet als fout', () => {
    expect(findArithmeticClaim('3 x 1.000,01 is 3.000,03')!.correct).toBe(true);
  });

  it('vindt niets in een zin zonder som', () => {
    expect(findArithmeticClaim('Ik verdien 4.200 euro bruto per maand.')).toBeNull();
  });
});
