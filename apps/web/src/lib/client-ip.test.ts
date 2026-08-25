import { describe, expect, it } from 'vitest';
import { bepaalClientIp, hashMetPeper } from './client-ip.js';

/** Bouwt een `lees`-functie uit een gewoon object, hoofdletterongevoelig zoals `Headers`. */
function kop(paren: Record<string, string>) {
  const lager = new Map(Object.entries(paren).map(([k, v]) => [k.toLowerCase(), v]));
  return (naam: string) => lager.get(naam.toLowerCase()) ?? null;
}

const PEPER = 'een-peper-van-ruim-zestien-tekens';

describe('het adres van de bezoeker', () => {
  it('neemt de header van de rand boven x-forwarded-for', () => {
    // Dit is de kern: de bezoeker stuurt een verzonnen adres mee en dat mag niet winnen.
    const uit = bepaalClientIp(
      kop({
        'x-forwarded-for': '1.2.3.4',
        'x-nf-client-connection-ip': '203.0.113.7',
      }),
    );
    expect(uit).toEqual({ adres: '203.0.113.7', vervalsbaar: false });
  });

  it('kent de randheaders van de bekende partijen', () => {
    for (const naam of ['cf-connecting-ip', 'true-client-ip', 'fly-client-ip']) {
      expect(bepaalClientIp(kop({ [naam]: '198.51.100.9' }))).toEqual({
        adres: '198.51.100.9',
        vervalsbaar: false,
      });
    }
  });

  it('valt terug op x-forwarded-for en zegt erbij dat die vervalsbaar is', () => {
    const uit = bepaalClientIp(kop({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }));
    expect(uit).toEqual({ adres: '1.2.3.4', vervalsbaar: true });
  });

  it('geeft null als er niets is', () => {
    expect(bepaalClientIp(kop({}))).toEqual({ adres: null, vervalsbaar: true });
  });
});

describe('de hash', () => {
  it('weigert zonder peper', () => {
    // Stil terugvallen op een kale hash zou eruitzien als bescherming die er niet is.
    expect(() => hashMetPeper('1.2.3.4', undefined)).toThrow(/ontbreekt of is te kort/);
    expect(() => hashMetPeper('1.2.3.4', 'tekort')).toThrow(/ontbreekt of is te kort/);
  });

  it('geeft met een andere peper een andere uitkomst', () => {
    // Anders zou de peper er wel staan maar niets doen — precies de fout die hij oplost.
    const a = hashMetPeper('1.2.3.4', PEPER);
    const b = hashMetPeper('1.2.3.4', `${PEPER}-anders`);
    expect(a).not.toEqual(b);
  });

  it('is stabiel voor hetzelfde adres', () => {
    expect(hashMetPeper('1.2.3.4', PEPER)).toEqual(hashMetPeper('1.2.3.4', PEPER));
  });

  it('bevat het adres zelf niet', () => {
    expect(hashMetPeper('1.2.3.4', PEPER)).not.toContain('1.2.3.4');
  });

  it('hasht een ontbrekend adres naar iets vasts in plaats van te gooien', () => {
    // Iedereen zonder herkenbaar adres deelt dan één emmer. Dat is streng maar veilig:
    // liever samen op de limiet dan allemaal ongelimiteerd.
    expect(hashMetPeper(null, PEPER)).toEqual(hashMetPeper(null, PEPER));
  });
});
