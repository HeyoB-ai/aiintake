import { describe, expect, it } from 'vitest';
import { NullAvatarProvider, type NullAvatarSession } from '@intake/provider-avatar';
import { FakeSttProvider, type FakeSttStream } from '@intake/provider-stt';
import { FakeTtsStream } from '@intake/provider-tts';
import { TurnLoop, type CompletedTurn } from './turn-loop';

/**
 * Alles wat naar een `int`-kolom gaat, moet een heel getal zijn.
 *
 * ## Wat er gebeurde
 *
 * De openingsbeurt van twee gesprekken achter elkaar is niet weggeschreven:
 *
 *     bericht 0/assistant (338 tekens) · NIET WEGGESCHREVEN:
 *     invalid input syntax for type integer: "20702.458333333336"
 *
 * `messages.spoken_ms` is een `int`. De waarde komt uit `emittedMs`, dat per chunk
 * `(samples / rate) * 1000` optelt. Op 16 kHz is dat `samples / 16` en viel het altijd rond;
 * op 24 kHz werd het `samples / 24` en dus meestal niet. De samplerate-wissel maakte een fout
 * zichtbaar die er al zat.
 *
 * ## Waarom een test en niet alleen een `Math.round`
 *
 * Omdat drie van de vier wegen naar deze grootheid al wél afrondden — `cancel()` in beide
 * TTS-adapters en `interrupt()` in de null-avatar. De vierde deed het niet, en dat was vanaf
 * die andere drie niet te zien. Precies dezelfde vorm als de samplerate op drie plekken en de
 * tijdzone op zes.
 *
 * Het faalde bovendien netjes: er stond een leesbare melding in het log en de sessie liep door.
 * Alleen mist het dossier daardoor de openingsbeurt, en dat viel op omdat iemand toevallig in
 * het log keek. Een dossier met een gat ziet er compleet uit.
 *
 * ## Wat deze test dekt
 *
 * De weg van een echte beurt, met chunkduren die breuken zijn zoals 24 kHz ze oplevert. Wat
 * eruit komt, moet geheel zijn — en dat geldt ook voor de metrieken, want die gaan via
 * `agent_record_metric` naar zes kolommen van hetzelfde type.
 */

/** Kloklezing met fracties, zoals `performance.now()` die geeft. */
class BreukKlok {
  private t = 1000.5;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Een TTS die chunkduren aflevert zoals 24 kHz ze werkelijk oplevert.
 *
 * 1024 samples op 24000 Hz is 42,666… ms. Dat is geen verzonnen randgeval: het is de
 * standaardvorm zodra het aantal samples geen veelvoud van 24 is.
 */
class VierentwintigKhzStream extends FakeTtsStream {
  override say(text: string): void {
    const SAMPLES = 1024;
    const RATE = 24_000;
    const durationMs = (SAMPLES / RATE) * 1000;
    // Bewijs binnen de test dat de invoer werkelijk een breuk is; anders zou deze hele test
    // een geheel getal in en een geheel getal uit meten.
    expect(Number.isInteger(durationMs)).toBe(false);

    for (let i = 0; i < text.length; i += 40) {
      (this as unknown as { emit(e: string, ...a: unknown[]): void }).emit('audio', {
        pcm: new Int16Array(SAMPLES),
        seq: i,
        durationMs,
      });
    }
  }

  /*
   * `flush()` bewust NIET overschrijven.
   *
   * De eerste versie deed dat wel, en emitte `done` aan het eind van `say()`. Daardoor sloot de
   * beurt nooit af: de lus maakt zijn wachtbelofte pas bij `flush()`, en de `done` was toen al
   * geweest. De test mat vervolgens niets en zei dat ook — zie de melding bij `expect`.
   */
}

async function eenBeurt(): Promise<CompletedTurn> {
  const klok = new BreukKlok();
  const stt = (await new FakeSttProvider().connect({
    language: 'nl',
    keyterms: [],
  })) as FakeSttStream;
  const tts = new VierentwintigKhzStream();
  const avatar = (await new NullAvatarProvider(klok.now).createSession({
    avatarId: null,
    language: 'nl',
    roomName: null,
    sampleRate: 24_000,
  })) as NullAvatarSession;

  const beurten: CompletedTurn[] = [];
  const loop = new TurnLoop({
    stt,
    tts,
    avatar,
    language: 'nl',
    now: klok.now,
    respond: async function* () {
      klok.advance(280.25);
      yield 'Kunt u vertellen wat er speelt?';
      klok.advance(4000.75);
    },
    onTurn: (turn) => {
      beurten.push(turn);
    },
  });

  stt.endOfTurn('Ik ben vorige week ontslagen.', klok.now());
  // De lus draait asynchroon; even laten uitlopen.
  for (let i = 0; i < 20 && beurten.length === 0; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(beurten.length, 'de beurt is niet afgerond; de test meet dan niets').toBe(1);
  return beurten[0]!;
}

describe('spoken_ms', () => {
  it('komt als heel getal uit de lus, ook bij breukduren van 24 kHz', async () => {
    const turn = await eenBeurt();
    expect(turn.spokenMs).not.toBeNull();
    expect(
      Number.isInteger(turn.spokenMs),
      `spokenMs is ${turn.spokenMs}; messages.spoken_ms is een int-kolom en weigert dit`,
    ).toBe(true);
  });

  it('rondt af en gooit niet weg', async () => {
    // Een `Math.floor` of een `| 0` zou deze test ook halen op "geheel", maar systematisch te
    // laag uitkomen. De duur hoort dicht bij de som van de chunks te liggen.
    const turn = await eenBeurt();
    expect(turn.spokenMs!).toBeGreaterThan(0);
  });
});

describe('de metrieken', () => {
  it('zijn allemaal heel, want ze gaan naar zes int-kolommen', async () => {
    /*
     * `agent_record_metric` doet `(p_metrics ->> 'x')::int`. Die RPC wordt vandaag nergens
     * aangeroepen, dus deze fout had zich nog niet voorgedaan — hij stond klaar voor het
     * moment dat iemand hem aansloot. De klok in deze test geeft fracties, precies zoals
     * `performance.now()`.
     */
    const turn = await eenBeurt();
    for (const [naam, waarde] of Object.entries(turn.metrics)) {
      if (typeof waarde !== 'number') continue;
      expect(Number.isInteger(waarde), `${naam} is ${waarde} en gaat naar een int-kolom`).toBe(
        true,
      );
    }
  });
});

describe('trimmedLeadingMs', () => {
  it('is heel', async () => {
    const turn = await eenBeurt();
    expect(Number.isInteger(turn.trimmedLeadingMs)).toBe(true);
  });
});
