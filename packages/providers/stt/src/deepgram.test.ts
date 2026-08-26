import { describe, expect, it } from 'vitest';
import { DeepgramSttStream, continuationInterval, isPlausibleContinuationGap } from './deepgram';

/**
 * De afkapdetectie, zonder netwerk.
 *
 * De protocolberichten van Deepgram worden rechtstreeks de berichtafhandeling in gevoerd.
 * Dat is wat er te testen valt: de detectie is rekenwerk over tijdstempels, en juist daar
 * ging het mis — niet in het transport.
 *
 * Aanleiding: live meldde het systeem "uitspraak te vroeg afgekapt (gat 7300 ms)". Twee
 * uitspraken die zeven seconden uit elkaar lagen werden aan elkaar geplakt. Dat is geen
 * drempel die te ruim staat maar een berekening zonder bovengrens — en de gevolgen zijn
 * erger dan niets doen: de eerste uitspraak krijgt tekst toegevoegd die er niet bij hoort.
 */

const UTTERANCE_END_MS = 1000;

interface Vangst {
  gapMs: number;
  detectedBy: string;
  fullUtterance: string;
}

function stroom(): {
  stuur: (bericht: unknown) => void;
  continuations: Vangst[];
  turns: { text: string; endedBy: string }[];
  leeg: { endedBy: string; resultaten: number; tekensGezien: number }[];
} {
  const s = new DeepgramSttStream(
    {
      apiKey: 'test',
      model: 'nova-3',
      endpointingMs: 300,
      utteranceEndMs: UTTERANCE_END_MS,
      sampleRate: 16_000,
    },
    { language: 'nl', keyterms: [] },
  );

  const continuations: Vangst[] = [];
  const turns: { text: string; endedBy: string }[] = [];
  s.on('turn_continued', (_t, meta) => continuations.push(meta as unknown as Vangst));
  s.on('end_of_turn', (text, meta) => turns.push({ text, endedBy: meta.endedBy }));
  const leeg: { endedBy: string; resultaten: number; tekensGezien: number }[] = [];
  s.on('empty_turn', (meta) => leeg.push({ ...meta }));

  // `onMessage` is privé en hoort dat te blijven: het is de protocolkant, geen API. Voor
  // de test is dit het enige punt waarop je echte Deepgram-berichten kunt injecteren.
  const intern = s as unknown as { onMessage(raw: string): void };
  return { stuur: (b) => intern.onMessage(JSON.stringify(b)), continuations, turns, leeg };
}

/** Een afgesloten beurt, zodat er een "open geval" is om tegenaan te detecteren. */
function sluitBeurt(stuur: (b: unknown) => void, start: number, duur: number, tekst: string) {
  stuur({
    type: 'Results',
    is_final: true,
    speech_final: true,
    start,
    duration: duur,
    channel: { alternatives: [{ transcript: tekst }] },
  });
}

describe('afkapdetectie — bovengrens', () => {
  it('meldt geen afkapping bij een gat groter dan utterance_end_ms', () => {
    const { stuur, continuations } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik ben ontslagen');

    // De cliënt zwijgt zeven seconden en begint dan iets nieuws. UtteranceEnd draagt een
    // last_word_end ver voorbij onze knip — precies het geval dat live 7300 ms meldde.
    stuur({ type: 'UtteranceEnd', last_word_end: 9.3 });

    expect(continuations).toHaveLength(0);
  });

  it('meldt evenmin bij een woordgat groter dan utterance_end_ms', () => {
    const { stuur, continuations } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik ben ontslagen');
    stuur({
      type: 'Results',
      is_final: true,
      start: 9.3,
      duration: 1,
      channel: { alternatives: [{ transcript: 'en ik wil advies' }] },
    });
    expect(continuations).toHaveLength(0);
  });

  it('meldt wél binnen de grens, en zegt welk signaal hem ving', () => {
    const { stuur, continuations } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik kreeg een vaststellingsovereenkomst');
    // 300 ms later: dat is een adempauze, geen nieuwe beurt.
    stuur({
      type: 'Results',
      is_final: true,
      start: 2.3,
      duration: 1,
      channel: { alternatives: [{ transcript: 'van mijn werkgever' }] },
    });

    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.detectedBy).toBe('word_gap');
    expect(continuations[0]!.gapMs).toBe(300);
    // De volledige uitspraak, want juist die was het dataverlies.
    expect(continuations[0]!.fullUtterance).toBe(
      'Ik kreeg een vaststellingsovereenkomst van mijn werkgever',
    );
  });

  it('vangt met UtteranceEnd wat het woordgat mist, binnen dezelfde grens', () => {
    const { stuur, continuations } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik ben ziek gemeld');
    // Het laatste woord kwam niet als final door, maar Deepgram zag het wél.
    stuur({ type: 'UtteranceEnd', last_word_end: 2.5 });

    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.detectedBy).toBe('utterance_end');
    expect(continuations[0]!.gapMs).toBe(500);
  });

  it('behandelt de bovengrens van het interval nog als afkapping', () => {
    // Deze test noemde eerst het getal 1000 — de definitionele grens uit ronde twee.
    // Sindsdien is er één interval, en dat is strenger: de getunede 600 ms. Een test die
    // een grens hardcodeert in plaats van hem bij het interval op te vragen, moet bij
    // elke tuning mee worden aangepast, en dat is precies hoe die grenzen uit elkaar
    // konden lopen.
    const interval = continuationInterval(UTTERANCE_END_MS);
    const { stuur, continuations } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik werk daar sinds maart');
    stuur({ type: 'UtteranceEnd', last_word_end: 2 + interval.maxMs / 1000 });
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.gapMs).toBe(interval.maxMs);
  });

  it('meldt één keer per geval, niet bij elk volgend segment', () => {
    const { stuur, continuations } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik ben ontslagen');
    stuur({
      type: 'Results',
      is_final: true,
      start: 2.2,
      duration: 0.5,
      channel: { alternatives: [{ transcript: 'op staande voet' }] },
    });
    stuur({
      type: 'Results',
      is_final: true,
      start: 2.8,
      duration: 0.5,
      channel: { alternatives: [{ transcript: 'vorige week' }] },
    });
    expect(continuations).toHaveLength(1);
  });
});

describe('hoe een beurt is afgesloten', () => {
  /**
   * Live viel één beurt op met een endpointing van 1283 ms tegen een normale 250–310.
   * Dat leek aarzelgedrag, maar het is een ander codepad: sluit de beurt via het vangnet,
   * dan wacht Deepgram eerst `utterance_end_ms` aan stilte af. Zo'n beurt kán niet onder
   * de duizend milliseconde uitkomen.
   *
   * Daarom staat het nu in de meting. Zonder dat label is een trage beurt niet te
   * onderscheiden van een beurt die nooit sneller had kunnen zijn.
   */
  it('meldt speech_final als het model de zin afsluit', () => {
    const { stuur, turns } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik ben ontslagen');
    expect(turns).toHaveLength(1);
    expect(turns[0]!.endedBy).toBe('speech_final');
  });

  it('meldt utterance_end als het vangnet de beurt sluit', () => {
    const { stuur, turns } = stroom();
    // Een final zonder speech_final: het laatste woord kwam niet als afsluiting door.
    stuur({
      type: 'Results',
      is_final: true,
      start: 0,
      duration: 2,
      channel: { alternatives: [{ transcript: 'Ik ben ontslagen' }] },
    });
    expect(turns).toHaveLength(0);

    stuur({ type: 'UtteranceEnd', last_word_end: 2 });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.endedBy).toBe('utterance_end');
  });
});

describe('de vorm van de afkapdetectie', () => {
  /**
   * Dit is de derde ronde aan deze detector, en dat is het probleem dat hier getest
   * wordt. Ronde één zette een bovengrens op de ene detector, ronde twee ontdekte dat de
   * andere er geen had, ronde drie dat de ondergrens ontbrak. Telkens was de
   * gerapporteerde waarde het symptoom en de verspreide definitie de oorzaak.
   *
   * Deze tests gaan daarom niet over 0 ms of 7300 ms maar over de vórm: er is één
   * interval, het is aaneengesloten, het zit onder de definitionele grens, en beide
   * detectoren gebruiken hetzelfde. Een vierde randgeval hoort hierdoor te vallen en niet
   * door een vierde patch.
   */

  it('accepteert precies één aaneengesloten interval en niets daarbuiten', () => {
    const interval = continuationInterval(UTTERANCE_END_MS);
    const geaccepteerd: number[] = [];
    for (let gap = -200; gap <= 3000; gap += 1) {
      if (isPlausibleContinuationGap(gap, interval)) geaccepteerd.push(gap);
    }

    expect(geaccepteerd.length).toBeGreaterThan(0);
    expect(geaccepteerd[0]).toBe(interval.minMs);
    expect(geaccepteerd.at(-1)).toBe(interval.maxMs);
    // Aaneengesloten: geen gaten in het midden, dus geen tweede regel die er stiekem
    // een stuk uit knipt.
    expect(geaccepteerd.length).toBe(interval.maxMs - interval.minMs + 1);
  });

  it('houdt de ondergrens boven nul — een knip vraagt een stilte om in te knippen', () => {
    const interval = continuationInterval(UTTERANCE_END_MS);
    expect(interval.minMs).toBeGreaterThan(0);
    expect(isPlausibleContinuationGap(0, interval)).toBe(false);
    expect(isPlausibleContinuationGap(-1, interval)).toBe(false);
  });

  it('blijft onder utterance_end_ms, ook als die lager wordt gezet', () => {
    // De relatie wordt afgedwongen en niet in twee constanten herhaald. Zonder deze eis
    // kan de tuning ongemerkt boven de definitionele grens uitkomen.
    for (const utteranceEndMs of [200, 400, 600, 1000, 3000]) {
      const interval = continuationInterval(utteranceEndMs);
      expect(interval.maxMs).toBeLessThanOrEqual(utteranceEndMs);
      expect(interval.maxMs).toBeGreaterThanOrEqual(interval.minMs);
    }
  });

  it('weigert waarden die geen getal zijn', () => {
    const interval = continuationInterval(UTTERANCE_END_MS);
    expect(isPlausibleContinuationGap(Number.NaN, interval)).toBe(false);
    expect(isPlausibleContinuationGap(Number.POSITIVE_INFINITY, interval)).toBe(false);
  });

  it('past hetzelfde interval toe op beide detectoren', () => {
    // Dit is de test die ronde twee én ronde drie had gevangen: de twee detectoren
    // hadden elk hun eigen grenzen. Zelfde gat, zelfde oordeel — welke detector hem ook
    // aandraagt.
    const interval = continuationInterval(UTTERANCE_END_MS);
    const gaten = [0, 10, interval.minMs, 300, interval.maxMs, interval.maxMs + 1, 7300];

    for (const gapMs of gaten) {
      const verwacht = isPlausibleContinuationGap(gapMs, interval);
      const gapSec = gapMs / 1000;

      const viaWoordgat = stroom();
      sluitBeurt(viaWoordgat.stuur, 0, 2, 'Ik ben ontslagen');
      viaWoordgat.stuur({
        type: 'Results',
        is_final: true,
        start: 2 + gapSec,
        duration: 0.5,
        channel: { alternatives: [{ transcript: 'en daarna' }] },
      });

      const viaUtteranceEnd = stroom();
      sluitBeurt(viaUtteranceEnd.stuur, 0, 2, 'Ik ben ontslagen');
      viaUtteranceEnd.stuur({ type: 'UtteranceEnd', last_word_end: 2 + gapSec });

      expect(viaWoordgat.continuations.length > 0, `woordgat bij ${gapMs} ms`).toBe(verwacht);
      expect(viaUtteranceEnd.continuations.length > 0, `utterance_end bij ${gapMs} ms`).toBe(
        verwacht,
      );
    }
  });
});

/**
 * Een beurt die begint en eindigt zonder woord.
 *
 * Dit verdween met een kale `return`: geen event, geen melding, geen spoor. Van buiten is
 * dat niet te onderscheiden van "de cliënt zweeg", terwijl het ook "de cliënt zei iets en
 * wij verstonden er geen woord van" kan zijn. Bij een correctie is dat verschil het hele
 * verschil — zie RISICOS.md risico 16.
 */
describe('lege beurt', () => {
  it('meldt ook wanneer het vangnet de beurt sluit', () => {
    const { stuur, turns, leeg } = stroom();

    stuur({ type: 'SpeechStarted' });
    stuur({ type: 'UtteranceEnd', last_word_end: 0.4 });

    expect(turns).toHaveLength(0);
    expect(leeg).toEqual([{ endedBy: 'utterance_end', resultaten: 0, tekensGezien: 0 }]);
  });

  it('telt de resultaten, zodat "niets gehoord" en "niets verstaan" te scheiden zijn', () => {
    const { stuur, leeg } = stroom();

    // Drie keer een Results zonder transcript: de herkenner zag wel iets en maakte er geen
    // woorden van. Nul zou betekenen dat er nooit een resultaat is geweest.
    stuur({ type: 'SpeechStarted' });
    for (let i = 0; i < 3; i += 1) {
      stuur({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: '' }] } });
    }
    stuur({ type: 'UtteranceEnd', last_word_end: 0.9 });

    expect(leeg).toEqual([{ endedBy: 'utterance_end', resultaten: 3, tekensGezien: 0 }]);
  });

  it('meldt niets bij een beurt die wél tekst opleverde', () => {
    const { stuur, turns, leeg } = stroom();

    stuur({ type: 'SpeechStarted' });
    stuur({
      type: 'Results',
      is_final: true,
      speech_final: true,
      start: 0,
      duration: 1.2,
      channel: { alternatives: [{ transcript: 'nee, het was februari' }] },
    });

    expect(turns).toEqual([{ text: 'nee, het was februari', endedBy: 'speech_final' }]);
    expect(leeg).toHaveLength(0);
  });

  it('telt per beurt en niet cumulatief', () => {
    const { stuur, leeg } = stroom();

    stuur({ type: 'SpeechStarted' });
    stuur({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: '' }] } });
    stuur({ type: 'UtteranceEnd', last_word_end: 0.4 });

    stuur({ type: 'SpeechStarted' });
    stuur({ type: 'UtteranceEnd', last_word_end: 1.4 });

    expect(leeg.map((l) => l.resultaten)).toEqual([1, 0]);
  });
});

/**
 * De twee paden waarop een uitspraak verdwijnt, en hoe je ze uit elkaar houdt.
 *
 * Live kwam deze melding binnen, met koptelefoon dus zonder akoestische lekkage:
 *
 *     beurt zonder bruikbare tekst — afgesloten door utterance_end, 1 resultaat
 *
 * Eén resultaat, geen woorden, gesloten door het vangnet. Twee verklaringen passen daar
 * allebei op, en het log kon er niet tussen kiezen — vandaar `tekensGezien`.
 */
describe('waarom een beurt leeg blijft', () => {
  it('sluit de beurt nu wél op een lege speech_final', () => {
    const { stuur, leeg } = stroom();

    stuur({ type: 'SpeechStarted' });
    stuur({
      type: 'Results',
      is_final: true,
      speech_final: true,
      start: 0,
      duration: 0.4,
      channel: { alternatives: [{ transcript: '' }] },
    });

    // Vóór deze reparatie gebeurde hier niets: de lege-tekstzeef keerde terug vóór de
    // speech_final-tak, de beurt bleef openstaan tot het vangnet, en `speaking` bleef
    // ondertussen true — wat elke volgende SpeechStarted onderdrukt.
    expect(leeg).toEqual([{ endedBy: 'speech_final', resultaten: 1, tekensGezien: 0 }]);
  });

  it('laat SpeechStarted weer door zodra de lege beurt gesloten is', () => {
    const s = stroom();
    const starts: number[] = [];

    // Twee keer spraak met een lege speech_final ertussen. De tweede SpeechStarted hoort
    // door te komen; dat is de barge-in-trigger.
    s.stuur({ type: 'SpeechStarted' });
    s.stuur({
      type: 'Results',
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: '' }] },
    });
    s.stuur({ type: 'SpeechStarted' });
    starts.push(s.leeg.length);

    s.stuur({ type: 'UtteranceEnd', last_word_end: 1.2 });
    expect(s.leeg).toHaveLength(2);
    expect(s.leeg[1]!.endedBy).toBe('utterance_end');
  });

  it('meldt dataverlies als er wél woorden waren maar geen final', () => {
    const { stuur, turns, leeg } = stroom();

    /*
     * Dit is het andere pad, en het ernstige.
     *
     * `pending` stapelt uitsluitend op `is_final`. Een tussentijds resultaat mét woorden
     * gaat als `partial` naar buiten en wordt weggegooid. Komt er daarna geen final maar
     * een UtteranceEnd, dan sluit de beurt leeg — terwijl de cliënt heeft gepraat en
     * Deepgram het heeft verstaan.
     *
     * `tekensGezien` boven nul is dus geen detail maar de handtekening van dataverlies.
     */
    stuur({ type: 'SpeechStarted' });
    stuur({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'nee het was februari' }] },
    });
    stuur({ type: 'UtteranceEnd', last_word_end: 1.4 });

    expect(turns).toHaveLength(0);
    expect(leeg).toHaveLength(1);
    expect(leeg[0]!.tekensGezien).toBe('nee het was februari'.length);
  });

  it('scheidt een kuch van een verdwenen uitspraak', () => {
    const kuch = stroom();
    kuch.stuur({ type: 'SpeechStarted' });
    kuch.stuur({ type: 'UtteranceEnd', last_word_end: 0.3 });

    const verdwenen = stroom();
    verdwenen.stuur({ type: 'SpeechStarted' });
    verdwenen.stuur({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'ik ben ontslagen' }] },
    });
    verdwenen.stuur({ type: 'UtteranceEnd', last_word_end: 1.1 });

    // Van buiten waren deze twee tot vandaag identiek: "beurt zonder bruikbare tekst".
    expect(kuch.leeg[0]!.tekensGezien).toBe(0);
    expect(verdwenen.leeg[0]!.tekensGezien).toBeGreaterThan(0);
  });

  it('telt de tekens per beurt en niet cumulatief', () => {
    const { stuur, leeg } = stroom();

    stuur({ type: 'SpeechStarted' });
    stuur({
      type: 'Results',
      is_final: false,
      channel: { alternatives: [{ transcript: 'abcde' }] },
    });
    stuur({ type: 'UtteranceEnd', last_word_end: 0.5 });

    stuur({ type: 'SpeechStarted' });
    stuur({ type: 'UtteranceEnd', last_word_end: 1.5 });

    expect(leeg.map((l) => l.tekensGezien)).toEqual([5, 0]);
  });
});
