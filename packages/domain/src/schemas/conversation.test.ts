import { describe, expect, it } from 'vitest';
import { isBackchannel, nietGehoord, truncateToSpoken } from './conversation';

/**
 * De truncatietest uit §11. Dit is de belangrijkste regel van de realtime-lus: sla in
 * het transcript alleen op wat de cliënt daadwerkelijk gehoord heeft.
 */
describe('transcript-truncatie na barge-in', () => {
  const intended =
    'Dank u wel voor die toelichting. Wanneer heeft u de vaststellingsovereenkomst ontvangen? ' +
    'En is er al getekend?';

  it('kapt af op de uitgesproken prefix', () => {
    // Onderbroken halverwege: ongeveer een derde uitgesproken.
    const result = truncateToSpoken(intended, 1000, 3000);
    expect(result.content.length).toBeLessThan(intended.length);
    expect(intended.startsWith(result.content)).toBe(true);
    expect(result.interruptedAtChar).toBe(result.content.length);
  });

  it('laat de tekst intact als er niet onderbroken is', () => {
    const result = truncateToSpoken(intended, 3000, 3000);
    expect(result.content).toBe(intended);
    expect(result.interruptedAtChar).toBe(intended.length);
  });

  it('de niet-uitgesproken vraag verdwijnt uit het transcript', () => {
    // Onderbreek zo vroeg dat de tweede vraag nooit hoorbaar was. Zou die blijven
    // staan, dan denkt het model dat het al naar ondertekening heeft gevraagd.
    const result = truncateToSpoken(intended, 300, 3000);
    expect(result.content).not.toMatch(/getekend/);
  });

  it('gebruikt woordtijdstempels als de provider ze levert', () => {
    const timings = [
      { charIndex: 0, startMs: 0 },
      { charIndex: 30, startMs: 900 },
      { charIndex: 84, startMs: 2100 },
    ];
    const result = truncateToSpoken(intended, 1000, 3000, timings);
    expect(result.interruptedAtChar).toBe(30);
    expect(result.content).toBe(intended.slice(0, 30));
  });

  it('valt niet om bij een totaalduur van nul', () => {
    const result = truncateToSpoken(intended, 0, 0);
    expect(result.content).toBe(intended);
  });
});

describe('de twee helften van de truncatie passen op elkaar', () => {
  /*
   * `truncateToSpoken` bepaalt wat de cliënt hóórde; `nietGehoord` wat hij juist niet meer
   * meekreeg. Die tweede stond als losse `slice` in `transcript.tsx` — dezelfde conventie, een
   * tweede keer opgeschreven, op de plek waar een advocaat het leest.
   *
   * Deze tests toetsen ze als paar. Verschuift de betekenis van `interruptedAtChar` ooit een
   * teken, dan valt dat hier om in plaats van in een dossier.
   */
  const ZIN = 'Wanneer heeft u de vaststellingsovereenkomst ontvangen?';

  it('samen vormen ze weer de hele zin', () => {
    for (const spoken of [0, 120, 500, 900, 1500]) {
      const { content, interruptedAtChar } = truncateToSpoken(ZIN, spoken, 1500);
      expect(content + nietGehoord(ZIN, interruptedAtChar), `bij ${spoken} ms`).toBe(ZIN);
    }
  });

  it('geeft niets terug als er niets is afgekapt', () => {
    // `truncateToSpoken` zet `interruptedAtChar` dan op de lengte van de zin.
    const { interruptedAtChar } = truncateToSpoken(ZIN, 2000, 1500);
    expect(nietGehoord(ZIN, interruptedAtChar)).toBe('');
  });

  it('valt niet om op een ontbrekende bedoelde tekst', () => {
    // In het dossier is `intended_content` nul zodra er niets is afgekapt.
    expect(nietGehoord(null, 12)).toBe('');
    expect(nietGehoord(ZIN, null)).toBe('');
  });

  it('geeft niets terug bij een index buiten de zin', () => {
    // Liever leeg dan een brokstuk: een advocaat leest hier wat de cliënt niet heeft gehoord.
    expect(nietGehoord(ZIN, -1)).toBe('');
    expect(nietGehoord(ZIN, ZIN.length + 5)).toBe('');
  });
});

describe('backchannels onderbreken niet', () => {
  it.each(['ja', 'oké', 'mm-hm', 'precies', 'Ja.'])('"%s" is een backchannel', (utterance) => {
    expect(isBackchannel(utterance, 250, 'nl')).toBe(true);
  });

  it('een lange uiting is nooit een backchannel, ook niet met dezelfde woorden', () => {
    expect(isBackchannel('ja', 900, 'nl')).toBe(false);
  });

  it('een echte onderbreking is geen backchannel', () => {
    expect(isBackchannel('nee wacht even, dat klopt niet', 1200, 'nl')).toBe(false);
  });

  it('werkt ook in het Engels', () => {
    expect(isBackchannel('right', 200, 'en')).toBe(true);
    expect(isBackchannel('right', 200, 'nl')).toBe(false);
  });
});
