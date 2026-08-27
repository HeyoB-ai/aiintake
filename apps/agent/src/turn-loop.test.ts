import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NullAvatarProvider, type NullAvatarSession } from '@intake/provider-avatar';
import { FakeSttProvider, type FakeSttStream } from '@intake/provider-stt';
import { FakeTtsProvider, FakeTtsStream, FAKE_MS_PER_CHAR } from '@intake/provider-tts';
import {
  TurnLoop,
  type CompletedTurn,
  type OnafgerondeWacht,
  type ResponseSource,
} from './turn-loop';
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
  wachten: OnafgerondeWacht[];
}

async function harness(
  respond: (h: () => Harness) => ResponseSource,
  opts: {
    cancelCostMs?: number;
    traagAnnuleren?: boolean;
    /** Zonder dit staat het inhouden uit, net als in de standaardconfiguratie van de lus. */
    onafgerondWachtMs?: number;
  } = {},
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
    sampleRate: 16_000,
  })) as NullAvatarSession;

  const turns: CompletedTurn[] = [];
  const ducks: boolean[] = [];
  const backchannels: string[] = [];
  const prematureCuts: { tekst: string; gapMs: number }[] = [];
  const skipped: string[] = [];
  const wachten: OnafgerondeWacht[] = [];

  let self!: Harness;
  const loop = new TurnLoop({
    stt,
    tts,
    avatar,
    language: 'nl',
    now: clock.now,
    ...(opts.onafgerondWachtMs === undefined
      ? {}
      : { onafgerondWachtMs: opts.onafgerondWachtMs }),
    onOnafgerondeWacht: (g) => {
      wachten.push(g);
    },
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

  self = {
    clock,
    stt,
    tts,
    avatar,
    loop,
    turns,
    ducks,
    backchannels,
    prematureCuts,
    skipped,
    wachten,
  };
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

/**
 * Het getal waarop de Fase 1-poort rust, per beurt.
 *
 * `totalResponseLatencyMs` wordt alleen gezet als de avatar `first_frame` meldt. De
 * null-provider deed dat één keer per sessie, omdat de lus de beurt nooit afsloot: hij riep
 * `avatar.endTurn?.()` aan terwijl de klasse de methode `finishTurn` noemde, en het
 * optionele vraagteken maakte er een stille no-op van.
 *
 * Gevolg: alleen de openingsbeurt had een totaal. En die beurt is de enige waarvan `t0`
 * niet een spraakeinde is maar het moment van `open()` — dus de poort werd getoetst op een
 * andere grootheid dan alle beurten die erna komen.
 */
describe('latencytotaal per beurt', () => {
  it('vult totalResponseLatencyMs ook voor de tweede en derde beurt', async () => {
    const h = await harness(
      (get) =>
        async function* () {
          get().clock.advance(120);
          yield ZIN_1;
          get().clock.advance(2000); // alles afgespeeld
        },
    );

    for (const zin of ['Ik kreeg een VSO.', 'Vorige week dinsdag.', 'Nee, nog niet getekend.']) {
      h.stt.endOfTurn(zin, h.clock.now());
      await new Promise((r) => setImmediate(r));
    }

    expect(h.turns).toHaveLength(3);

    const totalen = h.turns.map((t) => t.metrics.totalResponseLatencyMs);
    // Geen enkele null. Vóór de reparatie was dit [120, null, null].
    expect(totalen.every((v) => typeof v === 'number')).toBe(true);
    expect(totalen).toEqual([120, 120, 120]);
  });
});

/**
 * Zwijgen bij een onafgeronde zin.
 *
 * ## Wat hier eerst stond en waarom het fout was
 *
 * De eerste versie liet de assistent "Gaat u door." zeggen zodra de zin van de cliënt op een
 * komma of een voegwoord eindigde. Uit een gevoerd gesprek bleek dat precies de fout: de cliënt
 * haalde adem, de assistent begon te praten, en dáárom maakte hij zijn zin niet af. Elke
 * aanmoediging is zelf een onderbreking.
 *
 * De rijen in de database kunnen dat niet laten zien — daar staat alleen "drie seconden tussen
 * twee cliëntregels", en dat is niet te onderscheiden van een cliënt die zweeg. Zie onafgerond.ts.
 *
 * ## Waarom deze tests met nagebootste timers draaien
 *
 * Het inhouden gebeurt met een `setTimeout`. Alleen `setTimeout` en `clearTimeout` worden
 * nagebootst en `setImmediate` niet, want daarmee laten de bestaande tests de microtaken van de
 * lus leeglopen — dat moet blijven werken.
 */
describe('een onafgeronde zin: zwijgen en wachten', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tik = (): Promise<void> => new Promise((r) => setImmediate(r));

  /** Laat tijd verstrijken op beide klokken: die van de lus én die van de timers. */
  async function verstrijk(h: Harness, ms: number): Promise<void> {
    h.clock.advance(ms);
    vi.advanceTimersByTime(ms);
    await tik();
  }

  const KORT = 'Ik moest bij de grootaandeelhouder komen, ik ben directeur,';
  const VERVOLG = 'en die riep zich bij me.';

  const kortAntwoord =
    () =>
    // eslint-disable-next-line @typescript-eslint/require-await
    async function* (): AsyncGenerator<string> {
      yield 'Goed.';
    };

  it('zegt niets zolang de zin onafgerond is', async () => {
    const h = await harness(kortAntwoord, { onafgerondWachtMs: 1_200 });

    h.stt.endOfTurn(KORT, h.clock.now());
    await tik();

    // Dit is de kern: geen beurt, dus ook geen "Gaat u door." en geen nieuwe vraag.
    expect(h.turns).toHaveLength(0);
    expect(h.wachten.map((w) => w.fase)).toEqual(['wacht']);
    expect(h.wachten[0]!.tekens).toBe(KORT.length);
  });

  it('voegt het vervolg samen tot één beurt en antwoordt dan meteen', async () => {
    const h = await harness(kortAntwoord, { onafgerondWachtMs: 1_200 });

    h.stt.endOfTurn(KORT, h.clock.now());
    await tik();
    await verstrijk(h, 600);
    h.stt.endOfTurn(VERVOLG, h.clock.now());
    await tik();

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.clientUtterance).toBe(`${KORT} ${VERVOLG}`);
    // Niet uitzitten wat er niet meer nodig is: de zin is nu af, dus het wachten stopt.
    expect(h.turns[0]!.wachttijdOnafgerondMs).toBe(600);
    expect(h.wachten.map((w) => w.fase)).toEqual(['wacht', 'vervolg']);
  });

  it('antwoordt op wat er ligt als er niets meer komt', async () => {
    const h = await harness(kortAntwoord, { onafgerondWachtMs: 1_200 });

    h.stt.endOfTurn(KORT, h.clock.now());
    await tik();
    expect(h.turns).toHaveLength(0);

    await verstrijk(h, 1_200);

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.clientUtterance).toBe(KORT);
    expect(h.turns[0]!.wachttijdOnafgerondMs).toBe(1_200);
    expect(h.wachten.map((w) => w.fase)).toEqual(['wacht', 'verlopen']);
  });

  it('houdt een afgeronde zin niet in', async () => {
    /*
     * Zonder deze test is "hij wacht bij een komma" niet te onderscheiden van "hij wacht
     * altijd", en dan zou een detector die overal `true` teruggeeft er even groen uitzien.
     */
    const h = await harness(kortAntwoord, { onafgerondWachtMs: 1_200 });

    h.stt.endOfTurn('Ja, ik ben op 23 augustus mondeling op staande voet ontslagen.', h.clock.now());
    await tik();

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.wachttijdOnafgerondMs).toBe(0);
    expect(h.wachten).toEqual([]);
  });

  it('doet niets als de drempel op nul staat', async () => {
    // De stand waarmee je op gehoor kunt vergelijken. Zie ONAFGEROND_WACHT_MS in drempels.ts.
    const h = await harness(kortAntwoord, { onafgerondWachtMs: 0 });

    h.stt.endOfTurn(KORT, h.clock.now());
    await tik();

    expect(h.turns).toHaveLength(1);
    expect(h.wachten).toEqual([]);
  });

  it('blijft niet eeuwig hangen op een cliënt die stottert', async () => {
    /*
     * "en… dat ik… en… of" — elk stukje eindigt onafgerond en zou het wachten opnieuw
     * verlengen. Na MAX_VERLENGINGEN antwoordt de lus op wat er ligt; zonder die grens is
     * één hakkelende cliënt genoeg om het gesprek stil te leggen.
     */
    const h = await harness(kortAntwoord, { onafgerondWachtMs: 1_000 });

    for (const stuk of ['En toen dacht ik,', 'dat ik', 'en']) {
      h.stt.endOfTurn(stuk, h.clock.now());
      await tik();
      expect(h.turns, `na "${stuk}" hoort er nog niets gezegd te zijn`).toHaveLength(0);
      await verstrijk(h, 100);
    }

    h.stt.endOfTurn('of', h.clock.now());
    await tik();

    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]!.clientUtterance).toBe('En toen dacht ik, dat ik en of');
  });

  it('meldt een ingehouden zin als dataverlies wanneer de sessie sluit', async () => {
    const h = await harness(kortAntwoord, { onafgerondWachtMs: 1_200 });

    h.stt.endOfTurn(KORT, h.clock.now());
    await tik();
    h.loop.sluit();

    expect(h.skipped.some((s) => s.includes('DATAVERLIES'))).toBe(true);

    // En de timer is écht opgeruimd: er komt geen antwoord meer over een dichte keten.
    await verstrijk(h, 5_000);
    expect(h.turns).toHaveLength(0);
  });

  it('wacht niet terwijl de assistent zelf aan het woord is', async () => {
    /*
     * Dan is de uitspraak een onderbreking, en hoort zij te stoppen. Wachten zou daar het
     * omgekeerde doen van wat het hier moet doen: haar langer laten doorpraten over de cliënt
     * heen — precies het gedrag dat deze hele voorziening moet wegnemen.
     */
    let laatDoor!: () => void;
    const bezig = new Promise<void>((r) => {
      laatDoor = r;
    });

    const h = await harness(
      () =>
        async function* (): AsyncGenerator<string> {
          yield 'Ik ben nog aan het woord. ';
          await bezig;
          yield 'Klaar.';
        },
      { onafgerondWachtMs: 1_200 },
    );

    h.stt.endOfTurn('Eerste vraag.', h.clock.now());
    await tik();

    h.stt.endOfTurn('en toen dacht ik,', h.clock.now());
    await tik();

    expect(h.wachten, 'een onderbreking hoort niet ingehouden te worden').toEqual([]);

    laatDoor();
    await tik();
  });
});
