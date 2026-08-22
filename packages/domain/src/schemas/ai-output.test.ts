import { describe, expect, it } from 'vitest';
import { rejectUngroundedFacts, type ExtractedFact } from './ai-output';

/**
 * §11, AI-robuustheid: een gehallucineerd feit dat niet in het transcript staat, wordt
 * geweigerd. Niet gelogd-en-toch-opgeslagen, niet met lage confidence bewaard —
 * geweigerd.
 */

const TRANSCRIPT = [
  'Ik kreeg gisteren van mijn werkgever een vaststellingsovereenkomst en ze willen dat ik vrijdag teken.',
  'Ik werk daar sinds 2019 en verdien ongeveer 3800 euro bruto per maand.',
].join('\n');

function fact(overrides: Partial<ExtractedFact>): ExtractedFact {
  return {
    key: 'gross_monthly_salary',
    value: 3800,
    valueType: 'number',
    status: 'confirmed',
    confidence: 0.9,
    source: 'client_statement',
    sourceRef: 'msg-2',
    evidenceQuote: '3800 euro bruto per maand',
    ...overrides,
  };
}

describe('feiten zonder verankering in de bron', () => {
  it('accepteert een feit met een citaat dat er echt staat', () => {
    const { accepted, rejected } = rejectUngroundedFacts([fact({})], TRANSCRIPT);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('weigert een verzonnen citaat', () => {
    const hallucinated = fact({
      key: 'previous_warnings',
      value: true,
      valueType: 'boolean',
      evidenceQuote: 'ik heb vorig jaar twee officiële waarschuwingen gehad',
    });
    const { accepted, rejected } = rejectUngroundedFacts([hallucinated], TRANSCRIPT);
    expect(accepted).toHaveLength(0);
    expect(rejected[0]?.reason).toMatch(/komt niet voor in de bron/);
  });

  it('negeert verschillen in hoofdletters, accenten en witruimte', () => {
    const spaced = fact({ evidenceQuote: '3800   EURO  bruto per maand' });
    expect(rejectUngroundedFacts([spaced], TRANSCRIPT).accepted).toHaveLength(1);
  });

  it('weigert een citaat dat te kort is om iets te bewijzen', () => {
    const thin = fact({ evidenceQuote: 'a' });
    const { rejected } = rejectUngroundedFacts([thin], TRANSCRIPT);
    expect(rejected[0]?.reason).toMatch(/te kort/);
  });

  it('laat expliciet onbekende feiten door zonder citaat te eisen', () => {
    // "Niet vastgesteld" is zelf een uitkomst en heeft geen bewijs in de bron nodig.
    const unknownFact = fact({ key: 'currently_ill', status: 'unknown', evidenceQuote: 'n.v.t.' });
    const { accepted, rejected } = rejectUngroundedFacts([unknownFact], TRANSCRIPT);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it('scheidt goede en slechte feiten in dezelfde batch', () => {
    const { accepted, rejected } = rejectUngroundedFacts(
      [fact({}), fact({ key: 'employer_name', evidenceQuote: 'Acme Holding B.V.' })],
      TRANSCRIPT,
    );
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});
