import { describe, expect, it } from 'vitest';
import {
  BACKCHANNEL_MAX_MS,
  ENDPOINTING_MS,
  INTERRUPT_MIN_SPEECH_MS,
  INTERRUPT_MIN_WORDS,
  UTTERANCE_END_MS,
} from '@intake/domain';
import { classifySpeech } from './barge-in';
import { DrempelFout, drempelBanner, heeftAfwijking, leesDrempels } from './drempels';

/**
 * De drempels zijn af te stellen zonder deploy. Dat mag twee dingen niet kosten.
 *
 * Het eerste: de standaard mag niet verschuiven. Een omgevingsvariabele is een afwijking en
 * geen vervanging, dus zonder variabele hoort er precies te draaien wat er in de code staat.
 *
 * Het tweede: onzin mag niet stil worden geslikt. Een verkeerde stand hoor je pas in een
 * gesprek en niet in een foutmelding, dus de worker hoort te weigeren met een leesbare reden.
 */

describe('zonder afwijking', () => {
  it('levert precies de domeinconstanten', () => {
    const d = leesDrempels({});
    expect(d.interruptMinSpeechMs).toBe(INTERRUPT_MIN_SPEECH_MS);
    expect(d.interruptMinWords).toBe(INTERRUPT_MIN_WORDS);
    expect(d.backchannelMaxMs).toBe(BACKCHANNEL_MAX_MS);
    expect(heeftAfwijking(d)).toBe(false);
  });

  it('neemt de endpointing uit het domein en niet uit een eigen getal', () => {
    /*
     * Het getal stond op twee plekken: `standaard: 300` hier en `?? 300` in de
     * Deepgram-adapter. Dezelfde vorm als de samplerate — één grootheid, meerdere plekken.
     * Deze test en zijn tegenhanger in deepgram.test.ts binden ze allebei aan de bron.
     */
    expect(leesDrempels({}).endpointingMs).toBe(ENDPOINTING_MS);
    expect(leesDrempels({}).utteranceEndMs).toBe(UTTERANCE_END_MS);
    expect(ENDPOINTING_MS, 'de op gehoor afgestelde waarde').toBe(700);
  });

  it('leest de wachttijd voor een onafgeronde zin, nul inbegrepen', () => {
    /*
     * Nul is hier een geldige stand en geen "niet gezet": het is juist de stand waarmee je op
     * gehoor kunt vergelijken. Zou hij als leeg worden gelezen, dan sprong hij terug naar 1200
     * en zou een luistertest die het inhouden uitzet stilletjes met inhouden draaien.
     */
    expect(leesDrempels({}).onafgerondWachtMs).toBe(1_200);
    expect(leesDrempels({ ONAFGEROND_WACHT_MS: '0' }).onafgerondWachtMs).toBe(0);
    expect(heeftAfwijking(leesDrempels({ ONAFGEROND_WACHT_MS: '0' }))).toBe(true);
  });

  it('behandelt een lege waarde als niet gezet', () => {
    // Railway laat een variabele leeg achter als je hem wist in plaats van verwijdert. Zonder
    // deze regel wordt dat Number('') === 0, en dan staat er stilzwijgend een drempel van nul.
    const d = leesDrempels({ INTERRUPT_MIN_SPEECH_MS: '', BACKCHANNEL_MAX_MS: '   ' });
    expect(d.interruptMinSpeechMs).toBe(INTERRUPT_MIN_SPEECH_MS);
    expect(d.backchannelMaxMs).toBe(BACKCHANNEL_MAX_MS);
  });
});

describe('weigeren bij onzin', () => {
  it('weigert wat geen getal is, met de naam erbij', () => {
    expect(() => leesDrempels({ INTERRUPT_MIN_SPEECH_MS: 'hoog' })).toThrow(DrempelFout);
    expect(() => leesDrempels({ INTERRUPT_MIN_SPEECH_MS: 'hoog' })).toThrow(
      /INTERRUPT_MIN_SPEECH_MS/,
    );
  });

  it('weigert buiten het bereik, met de reden erbij', () => {
    // De reden hoort in de melding: een grens zonder reden wordt door de volgende persoon
    // verruimd omdat hij in de weg zit.
    expect(() => leesDrempels({ INTERRUPT_MIN_WORDS: '0' })).toThrow(
      /onderbreekt een lege partial/,
    );
    expect(() => leesDrempels({ DEEPGRAM_UTTERANCE_END_MS: '500' })).toThrow(/1000/);
  });

  it('weigert een kommagetal waar een geheel getal hoort', () => {
    expect(() => leesDrempels({ INTERRUPT_MIN_WORDS: '2.5' })).toThrow(/geheel getal/);
  });

  it('laat een kommagetal toe waar dat wél mag', () => {
    // MIC_GATE_RMS is een fractie; hem als geheel getal eisen zou het hele bereik onbruikbaar
    // maken — 0 of 1, en niets ertussen.
    expect(leesDrempels({ MIC_GATE_RMS: '0.02' }).micGateRms).toBe(0.02);
  });

  it('noemt álle klachten en niet alleen de eerste', () => {
    // Wie drie variabelen tegelijk zet, wil niet drie keer opnieuw deployen om ze een voor een
    // te horen.
    const fout = (() => {
      try {
        leesDrempels({ INTERRUPT_MIN_WORDS: '0', MIC_GATE_RMS: '9', DEEPGRAM_ENDPOINTING_MS: 'x' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(fout).toBeInstanceOf(DrempelFout);
    expect(fout!.message).toMatch(/INTERRUPT_MIN_WORDS/);
    expect(fout!.message).toMatch(/MIC_GATE_RMS/);
    expect(fout!.message).toMatch(/DEEPGRAM_ENDPOINTING_MS/);
  });
});

describe('de opstartbanner', () => {
  it('markeert wat afwijkt en laat de standaard zien', () => {
    const regels = drempelBanner(leesDrempels({ BACKCHANNEL_MAX_MS: '2000' }));
    const regel = regels.find((r) => r.includes('BACKCHANNEL_MAX_MS'))!;
    expect(regel.trimStart().startsWith('*')).toBe(true);
    expect(regel).toMatch(/2000/);
    // De standaard hoort erbij te staan: zonder dat weet je achteraf wel wat er stond, maar
    // niet waarvan het afweek.
    expect(regel).toMatch(new RegExp(`standaard ${BACKCHANNEL_MAX_MS}`));
  });

  it('markeert niets als er niets afwijkt', () => {
    for (const r of drempelBanner(leesDrempels({}))) {
      expect(r.trimStart().startsWith('*')).toBe(false);
    }
  });

  it('noemt elke variabele, ook de ongewijzigde', () => {
    // Anders is "welke stand stond er tijdens dat gesprek" achteraf niet te beantwoorden voor
    // de waarden die niemand heeft aangeraakt.
    const tekst = drempelBanner(leesDrempels({})).join('\n');
    for (const naam of [
      'INTERRUPT_MIN_SPEECH_MS',
      'INTERRUPT_MIN_WORDS',
      'BACKCHANNEL_MAX_MS',
      'DEEPGRAM_ENDPOINTING_MS',
      'DEEPGRAM_UTTERANCE_END_MS',
      'ONAFGEROND_WACHT_MS',
      'MIC_GATE_RMS',
      'MIC_GATE_CLOSE_MS',
    ]) {
      expect(tekst).toContain(naam);
    }
  });
});

describe('de afwijking komt ook werkelijk aan', () => {
  /*
   * De vorige twee blokken toetsen het lezen. Dit blok toetst dat er iets mee gebeurt — anders
   * is dit een instelling die netjes wordt gevalideerd, netjes wordt gelogd, en verder niets
   * doet. Dat patroon heeft dit project al vaker opgeleverd.
   */
  const evidence = { speechMs: 1_570, text: 'ja' };

  it('laat "ja" onderbreken op de standaard — dat is risico 21', () => {
    expect(classifySpeech(evidence, 'nl').kind).toBe('interrupt');
  });

  it('houdt "ja" tegen zodra BACKCHANNEL_MAX_MS erboven staat', () => {
    const d = leesDrempels({ BACKCHANNEL_MAX_MS: '2000' });
    const besluit = classifySpeech(evidence, 'nl', {
      interruptMinSpeechMs: d.interruptMinSpeechMs,
      interruptMinWords: d.interruptMinWords,
      backchannelMaxMs: d.backchannelMaxMs,
    });
    expect(besluit.kind).toBe('backchannel');
  });

  it('laat een woorddrempel van 3 een tweewoordige partial doorlaten', () => {
    const twee = { speechMs: 50, text: 'wacht even' };
    expect(classifySpeech(twee, 'nl').kind).toBe('interrupt');

    const d = leesDrempels({ INTERRUPT_MIN_WORDS: '3', INTERRUPT_MIN_SPEECH_MS: '5000' });
    const besluit = classifySpeech(twee, 'nl', {
      interruptMinSpeechMs: d.interruptMinSpeechMs,
      interruptMinWords: d.interruptMinWords,
      backchannelMaxMs: d.backchannelMaxMs,
    });
    expect(besluit.kind).toBe('ignore');
  });
});
