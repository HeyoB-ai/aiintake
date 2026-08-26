import { describe, expect, it } from 'vitest';
import { NullAvatarProvider, type NullAvatarSession } from '@intake/provider-avatar';
import { FakeSttProvider, type FakeSttStream } from '@intake/provider-stt';
import { FakeTtsProvider, FakeTtsStream, FAKE_MS_PER_CHAR } from '@intake/provider-tts';
import { TurnLoop, type CompletedTurn, type ResponseSource } from './turn-loop';
import { formatHudLine, meetsPhaseOneGate } from './metrics';

/**
 * Het synthetische barge-in-harnas.
 *
 * Met echte spraak kun je niet reproduceerbaar op exact 700 ms onderbreken, en zonder
 * dat kun je de truncatie niet controleren. Hier bepaalt de test zelf wanneer de cliënt
 * begint te praten en hoeveel audio er op dat moment is afgespeeld — dus wat er precies
 * in het transcript hoort te staan.
 *
 * Draait zonder netwerk en zonder één API-key: fakes voor STT en TTS, de
 * null-avatarprovider met een echte afspeelklok.
 */

class TestClock {
  t = 0;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/** TTS die tijd laat verstrijken bij het annuleren, zodat interrupt→stilte meetbaar is. */
class ClockedTtsStream extends FakeTtsStream {
  constructor(
    private readonly clock: TestClock,
    private readonly cancelCostMs: number,
    /**
     * Laat het annuleren een macrotaak kosten in plaats van alleen kloktijd.
     *
     * Zonder dit is `cancel()` een opgeloste promise en draait de rest van `interrupt()`
     * in dezelfde macrotaak — er kan dan per definitie geen STT-event tussen vallen, en
     * de volgorde die deze fakes afdwingen bestaat in productie niet. Cartesia stuurt
     * vandaag alleen een bericht en wacht nergens op; gaat hij ooit op een bevestiging
     * wachten, dan is dit het gedrag dat telt.
     */
    private readonly traagAnnuleren = false,
  ) {
    super();
  }

  override async cancel(): Promise<{ spokenMs: number }> {
    this.clock.advance(this.cancelCostMs);
    if (this.traagAnnuleren) await new Promise((r) => setImmediate(r));
    return super.cancel();
  }
}

interface Harness {
  clock: TestClock;
  stt: FakeSttStream;
  tts: FakeTtsStream;
  avatar: NullAvatarSession;
  loop: TurnLoop;
  turns: CompletedTurn[];
  ducks: boolean[];
  backchannels: string[];
  prematureCuts: { tekst: string; gapMs: number }[];
  skipped: string[];
}

async function harness(
  respond: (h: () => Harness) => ResponseSource,
  opts: { cancelCostMs?: number; traagAnnuleren?: boolean } = {},
): Promise<Harness> {
  const clock = new TestClock();

  const sttProvider = new FakeSttProvider();
  const stt = (await sttProvider.connect({ language: 'nl', keyterms: [] })) as FakeSttStream;

  const ttsProvider = new FakeTtsProvider();
  await ttsProvider.open({ voiceId: 'test', language: 'nl' });
  const tts = new ClockedTtsStream(clock, opts.cancelCostMs ?? 12, opts.traagAnnuleren ?? false);

  const avatarProvider = new NullAvatarProvider(clock.now);
  const avatar = (await avatarProvider.createSession({
    avatarId: null,
    language: 'nl',
    roomName: null,
  })) as NullAvatarSession;

  const turns: CompletedTurn[] = [];
  const ducks: boolean[] = [];
  const backchannels: string[] = [];
  const prematureCuts: { tekst: string; gapMs: number }[] = [];
  const skipped: string[] = [];

  let self!: Harness;
  const loop = new TurnLoop({
    stt,
    tts,
    avatar,
    language: 'nl',
    now: clock.now,
    respond: respond(() => self),
    onTurn: (turn) => {
      turns.push(turn);
    },
    onDuck: (d) => {
      ducks.push(d);
    },
    onBackchannel: (t) => {
      backchannels.push(t);
    },
    onPrematureCut: (tekst, gapMs) => {
      prematureCuts.push({ tekst, gapMs });
    },
    onSkippedTurn: (reden) => {
      skipped.push(reden);
    },
  });

  self = { clock, stt, tts, avatar, loop, turns, ducks, backchannels, prematureCuts, skipped };
  return self;
}

const ZIN_1 = 'Dank u wel voor die toelichting.';
const ZIN_2 = 'Wanneer heeft u de vaststellingsovereenkomst ontvangen?';
const ZIN_3 = 'En is er al getekend?';

describe('beurtcyclus zonder onderbreking', () => {
  it('levert de volledige tekst en een gevulde latencybegroting', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          get().clock.advance(280); // time-to-first-token
          yield `${ZIN_1} `;
          yield `${ZIN_2} `;
          yield ZIN_3;
          get().clock.advance(4000); // alles afgespeeld
        },
    );

    h.stt.endOfTurn('Ik kreeg gisteren een vaststellingsovereenkomst.', h.clock.now());
    await new Promise((r) => setImmediate(r));

    expect(h.turns).toHaveLength(1);
    const turn = h.turns[0]!;
    expect(turn.assistantContent).toContain('Dank u wel');
    expect(turn.assistantContent).toContain('getekend');
    expect(turn.interruptedAtChar).toBeNull();
    expect(turn.metrics.wasInterrupted).toBe(false);
    expect(turn.metrics.sttToLlmFirstTokenMs).toBe(280);
    expect(turn.metrics.totalResponseLatencyMs).toBe(280);
  });

  it('flusht per zin, dus de TTS krijgt drie losse zinnen', async () => {
    const h = await harness(
      () =>
        async function* () {
          yield `${ZIN_1} ${ZIN_2} ${ZIN_3}`;
        },
    );

    h.stt.endOfTurn('vertel', h.clock.now());
    await new Promise((r) => setImmediate(r));

    expect(h.tts.spoken).toEqual([ZIN_1, ZIN_2, ZIN_3]);
  });
});

describe('barge-in', () => {
  /**
   * De kerntest: onderbreken terwijl zin 1 nog loopt. Wat daarna zou komen is nooit
   * hoorbaar geweest en mag dus niet in het transcript staan.
   */
  it('kapt het transcript af op wat daadwerkelijk is uitgesproken', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          get().clock.advance(300);
          yield `${ZIN_1} `;
          // Zin 1 is naar de TTS en de audio staat in de buffer. Laat er 700 ms van
          // afspelen en onderbreek dan.
          get().clock.advance(700);
          await get().loop.onClientSpeech({ speechMs: 320, text: 'nee wacht even' });
          // Deze twee zinnen worden niet meer uitgesproken.
          yield `${ZIN_2} `;
          yield ZIN_3;
        },
    );

    h.stt.endOfTurn('Ik kreeg een VSO.', h.clock.now());
    await new Promise((r) => setImmediate(r));

    const turn = h.turns[0]!;

    expect(turn.metrics.wasInterrupted).toBe(true);

    // 700 ms afgespeeld plus de 12 ms die het annuleren van de TTS kost. Dat die 12 ms
    // meetellen is juist: in die tijd klinkt de audio nog. Zou de meting vóór het
    // annuleren gebeuren, dan kapten we het transcript af op minder dan de cliënt
    // werkelijk heeft gehoord.
    expect(turn.spokenMs).toBe(712);

    // Alleen een prefix van zin 1 is gehoord.
    expect(ZIN_1.startsWith(turn.assistantContent)).toBe(true);
    expect(turn.assistantContent.length).toBeLessThan(ZIN_1.length);
    expect(turn.interruptedAtChar).toBe(turn.assistantContent.length);

    // En de niet-gestelde vraag staat er niet in. Zou die er wél staan, dan denkt het
    // model dat het al naar de VSO-datum heeft gevraagd.
    expect(turn.assistantContent).not.toContain('vaststellingsovereenkomst');
    expect(turn.assistantContent).not.toContain('getekend');
  });

  it('rekent de uitgesproken prefix uit met de afspeelklok, niet met de buffer', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          yield `${ZIN_1} `;
          get().clock.advance(700);
          await get().loop.onClientSpeech({ speechMs: 400, text: 'ho even' });
          yield ZIN_2;
        },
    );

    h.stt.endOfTurn('test', h.clock.now());
    await new Promise((r) => setImmediate(r));

    // Uitgesproken tijd gedeeld door de totale duur van de zin, maal het aantal tekens.
    // Gerekend met de gemeten spokenMs, niet met de 700 uit het scenario: het annuleren
    // van de TTS kost zelf ook tijd en die telt mee.
    const turn = h.turns[0]!;
    const totaleDuur = ZIN_1.length * FAKE_MS_PER_CHAR;
    const verwachteTekens = Math.floor((turn.spokenMs! / totaleDuur) * ZIN_1.length);
    expect(turn.assistantContent.length).toBe(verwachteTekens);
  });

  it('is binnen 50 ms stil', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          yield `${ZIN_1} `;
          get().clock.advance(500);
          await get().loop.onClientSpeech({ speechMs: 250, text: 'stop maar' });
          yield ZIN_2;
        },
      { cancelCostMs: 12 },
    );

    h.stt.endOfTurn('test', h.clock.now());
    await new Promise((r) => setImmediate(r));

    const stil = h.turns[0]!.metrics.interruptToSilenceMs!;
    expect(stil).toBe(12);
    expect(stil).toBeLessThan(50);
  });

  it('geeft de gehoorde prefix mee aan de volgende beurt, zodat er niet letterlijk wordt herhaald', async () => {
    const gezien: (string | undefined)[] = [];
    const h = await harness(
      (get) =>
        async function* (input) {
          gezien.push(input.interruptedPrefix);
          if (gezien.length === 1) {
            yield `${ZIN_1} `;
            get().clock.advance(600);
            await get().loop.onClientSpeech({ speechMs: 300, text: 'nee toch niet' });
            yield ZIN_2;
          } else {
            yield 'Kort dan: wanneer kreeg u hem?';
          }
        },
    );

    h.stt.endOfTurn('eerste', h.clock.now());
    await new Promise((r) => setImmediate(r));
    h.stt.endOfTurn('tweede', h.clock.now());
    await new Promise((r) => setImmediate(r));

    expect(gezien[0]).toBeUndefined();
    expect(gezien[1]).toBeDefined();
    expect(ZIN_1.startsWith(gezien[1]!)).toBe(true);
  });
});

describe('vals-positief-bescherming', () => {
  it('een backchannel onderbreekt niet en komt door als bevestiging', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          yield `${ZIN_1} `;
          get().clock.advance(400);
          await get().loop.onClientSpeech({ speechMs: 220, text: 'ja' });
          yield `${ZIN_2} `;
          get().clock.advance(4000);
        },
    );

    h.stt.endOfTurn('test', h.clock.now());
    await new Promise((r) => setImmediate(r));

    expect(h.backchannels).toEqual(['ja']);
    expect(h.turns[0]!.metrics.wasInterrupted).toBe(false);
    expect(h.turns[0]!.assistantContent).toContain('vaststellingsovereenkomst');
  });

  it('een kort geluid zonder woorden onderbreekt niet en heft de demping op', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          yield `${ZIN_1} `;
          get().clock.advance(300);
          await get().loop.onClientSpeech({ speechMs: 90 });
          yield `${ZIN_2} `;
          get().clock.advance(4000);
        },
    );

    h.stt.endOfTurn('test', h.clock.now());
    await new Promise((r) => setImmediate(r));

    expect(h.turns[0]!.metrics.wasInterrupted).toBe(false);
    expect(h.ducks).toContain(false);
  });

  it('twee woorden onderbreken ook als de spraak kort was', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          yield `${ZIN_1} `;
          get().clock.advance(300);
          await get().loop.onClientSpeech({ speechMs: 100, text: 'nee stop' });
          yield ZIN_2;
        },
    );

    h.stt.endOfTurn('test', h.clock.now());
    await new Promise((r) => setImmediate(r));

    expect(h.turns[0]!.metrics.wasInterrupted).toBe(true);
  });
});

describe('HUD', () => {
  it('vat een beurt samen zonder persoonsgegevens', () => {
    const line = formatHudLine({
      speechEndToSttFinalMs: 210,
      sttToLlmFirstTokenMs: 290,
      llmToTtsFirstAudioMs: 70,
      ttsToAvatarFirstFrameMs: 160,
      totalResponseLatencyMs: 730,
      interruptToSilenceMs: null,
      wasInterrupted: false,
    });
    expect(line).toContain('totaal 730ms');
    expect(line).not.toContain('vaststellingsovereenkomst');
  });

  it('beoordeelt de Fase 1-poort op p50', () => {
    expect(meetsPhaseOneGate([900, 1100, 1200]).passes).toBe(true);
    expect(meetsPhaseOneGate([1400, 1900, 2200]).passes).toBe(false);
  });
});

describe('te vroeg afgekapte uitspraak', () => {
  /**
   * Het geval uit RISICOS.md risico 2: de STT besluit dat de cliënt klaar is terwijl hij
   * nog midden in een zin zit. Zonder detectie beantwoordt de assistent een halve vraag
   * en klinkt daarbij volkomen zeker.
   */
  it('breekt het antwoord af zodra blijkt dat de cliënt nog aan het woord was', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          yield `${ZIN_1} `;
          get().clock.advance(400);
          // De rest van de uitspraak komt alsnog binnen.
          get().stt.continueTurn('van mijn werkgever.', 120, 'Ik kreeg een VSO');
          yield ZIN_2;
        },
    );
    h.stt.endOfTurn('Ik kreeg een VSO', h.clock.now());
    await new Promise((r) => setImmediate(r));

    const turn = h.turns[0]!;

    // De vlag is het punt: zonder dit ziet het transcript er compleet uit.
    expect(turn.clientUtteranceWasCut).toBe(true);
    expect(h.prematureCuts).toHaveLength(1);
    expect(h.prematureCuts[0]!.gapMs).toBe(120);

    // En de volledige uitspraak staat er, niet de halve.
    expect(turn.clientUtterance).toBe('Ik kreeg een VSO van mijn werkgever.');

    // Het antwoord op de halve vraag is afgebroken in plaats van afgemaakt.
    expect(turn.assistantContent).not.toContain('vaststellingsovereenkomst ontvangen');
  });

  it('markeert een normale beurt niet als afgekapt', async () => {
    const h = await harness(
      () =>
        async function* () {
          yield `${ZIN_1} `;
        },
    );

    h.stt.endOfTurn('Ik kreeg een VSO.', h.clock.now());
    await new Promise((r) => setImmediate(r));

    expect(h.turns[0]!.clientUtteranceWasCut).toBe(false);
  });
});

describe('beurt zonder inhoud van de cliënt', () => {
  /**
   * Live liep dit stuk op `messages.0: user messages must have non-empty content`.
   *
   * De STT meldt end_of_turn ook na geluid dat geen woorden opleverde. Zonder zeef
   * beantwoordt de assistent een uitspraak die niet bestaat én belandt er een leeg
   * cliëntbericht in de geschiedenis — en dat laatste breekt niet die beurt maar alle
   * volgende. Eén kuch legde zo het gesprek stil.
   */
  it('start geen beurt en meldt dat hij blijft wachten', async () => {
    let aangeroepen = 0;
    const h = await harness(
      () =>
        async function* () {
          aangeroepen += 1;
          yield 'dit hoort niet te gebeuren';
        },
    );

    h.stt.endOfTurn('   ', h.clock.now());
    await new Promise((r) => setTimeout(r, 10));

    expect(aangeroepen).toBe(0);
    expect(h.turns).toHaveLength(0);
    // Zichtbaar overgeslagen: stilte zonder melding is niet te onderscheiden van een
    // vastgelopen lus.
    expect(h.skipped).toEqual(['geen bruikbare tekst van de STT']);
  });

  it('blijft daarna gewoon werken', async () => {
    const h = await harness(
      () =>
        async function* () {
          yield ZIN_1;
        },
    );

    h.stt.endOfTurn('', h.clock.now());
    await new Promise((r) => setTimeout(r, 10));
    h.stt.endOfTurn('Ik heb een vraag.', h.clock.now());
    await new Promise((r) => setTimeout(r, 60));

    expect(h.skipped).toHaveLength(1);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.clientUtterance).toBe('Ik heb een vraag.');
  });
});

/**
 * Wat er gebeurt als de correctie binnenkomt terwijl de interrupt nog loopt.
 *
 * Dit is het geval waar de cliënt het meest aan hecht: hij hoort iets fout, valt de
 * assistent in de rede, en zegt hoe het wél zit. Die uitspraak arriveert per definitie
 * midden in de afhandeling van de onderbreking.
 *
 * `handleTurn` had daar geen enkel besef van. Hij zette `state` op `responding` en wiste
 * `sentToTts`, `emittedMs` en `intended` — precies de velden waarop `interrupt()` ná zijn
 * `await`s de truncatie berekent. `completeTurn` schreef de zojuist binnengekomen uitspraak
 * daarna weg als de uitspraak die de ónderbroken beurt had gestart.
 *
 * Met de huidige fakes valt dat niet te zien: `cancel()` en `interrupt()` geven een
 * opgeloste promise, dus er kan geen macrotaak tussen vallen. `traagAnnuleren` zet precies
 * die aanname uit.
 */
describe('uitspraak tijdens een lopende interrupt', () => {
  it('hoort bij de volgende beurt en niet bij de onderbroken beurt', async () => {
    let laatDoor!: () => void;
    const vastgehouden = new Promise<void>((r) => {
      laatDoor = r;
    });

    const h = await harness(
      (get) =>
        async function* () {
          get().clock.advance(300);
          yield `${ZIN_1} `;
          get().clock.advance(700);
          // De beurt blijft openstaan tot de test hem loslaat, zodat de lus in
          // `responding` blijft terwijl wij het venster construeren.
          await vastgehouden;
          yield ZIN_2;
        },
      { traagAnnuleren: true },
    );

    h.stt.endOfTurn('Ik kreeg een VSO.', h.clock.now());
    await new Promise((r) => setImmediate(r));

    // De cliënt onderbreekt. Niet awaiten: in productie is dit een los STT-event.
    void h.loop.onClientSpeech({ speechMs: 320, text: 'nee wacht' });

    // En hier komt de correctie binnen — terwijl `interrupt()` nog op de TTS wacht.
    h.stt.endOfTurn('Nee, het was februari.', h.clock.now());

    laatDoor();
    // Ruim wachten: er zitten hier meer stappen achter elkaar dan bij een gewone beurt —
    // de interrupt, de afronding daarvan, en dan pas de nieuwe beurt met zijn synthese.
    await new Promise((r) => setTimeout(r, 50));

    expect(h.turns).toHaveLength(2);

    // De onderbroken beurt houdt zijn eigen uitspraak, en zijn afkapping.
    expect(h.turns[0]!.clientUtterance).toBe('Ik kreeg een VSO.');
    expect(h.turns[0]!.interruptedAtChar).not.toBeNull();
    expect(ZIN_1.startsWith(h.turns[0]!.assistantContent)).toBe(true);

    // En de correctie staat als eigen beurt in het transcript. Zou dit 'Ik kreeg een VSO.'
    // teruggeven, dan was de correctie van de cliënt uit het dossier verdwenen terwijl de
    // foute bewering met een kloppend citaat bleef staan. Zie RISICOS.md risico 16.
    expect(h.turns[1]!.clientUtterance).toBe('Nee, het was februari.');
  });

  it('kapt de onderbroken beurt niet af op de velden van de nieuwe', async () => {
    let laatDoor!: () => void;
    const vastgehouden = new Promise<void>((r) => {
      laatDoor = r;
    });

    const h = await harness(
      (get) =>
        async function* () {
          get().clock.advance(300);
          yield `${ZIN_1} `;
          get().clock.advance(700);
          await vastgehouden;
          yield ZIN_2;
        },
      { traagAnnuleren: true },
    );

    h.stt.endOfTurn('Ik kreeg een VSO.', h.clock.now());
    await new Promise((r) => setImmediate(r));

    void h.loop.onClientSpeech({ speechMs: 320, text: 'nee wacht' });
    h.stt.endOfTurn('Nee, het was februari.', h.clock.now());

    laatDoor();
    // Ruim wachten: er zitten hier meer stappen achter elkaar dan bij een gewone beurt —
    // de interrupt, de afronding daarvan, en dan pas de nieuwe beurt met zijn synthese.
    await new Promise((r) => setTimeout(r, 50));

    // 700 ms afgespeeld plus 12 ms annuleerkosten, net als in de kerntest hierboven. Zou
    // `handleTurn` `emittedMs` tussentijds op nul hebben gezet, dan stond hier 0 en was
    // het transcript van de assistent leeg — terwijl de cliënt haar wel degelijk hoorde.
    expect(h.turns[0]!.spokenMs).toBe(712);
    expect(h.turns[0]!.assistantContent.length).toBeGreaterThan(0);
  });
});
