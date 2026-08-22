import { describe, expect, it } from 'vitest';
import { DeepgramSttStream } from './deepgram';

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

  // `onMessage` is privé en hoort dat te blijven: het is de protocolkant, geen API. Voor
  // de test is dit het enige punt waarop je echte Deepgram-berichten kunt injecteren.
  const intern = s as unknown as { onMessage(raw: string): void };
  return { stuur: (b) => intern.onMessage(JSON.stringify(b)), continuations, turns };
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

  it('behandelt precies utterance_end_ms nog als afkapping', () => {
    // De grens hoort inclusief te zijn: bij exact dat gat besluit Deepgram zelf dat de
    // uitspraak voorbij is, en dat moment telt nog mee als "het hoorde erbij".
    const { stuur, continuations } = stroom();
    sluitBeurt(stuur, 0, 2, 'Ik werk daar sinds maart');
    stuur({ type: 'UtteranceEnd', last_word_end: 3 });
    expect(continuations).toHaveLength(1);
    expect(continuations[0]!.gapMs).toBe(1000);
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
