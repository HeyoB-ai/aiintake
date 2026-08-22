import { describe, expect, it } from 'vitest';
import { isBackchannel, truncateToSpoken } from './conversation';

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
