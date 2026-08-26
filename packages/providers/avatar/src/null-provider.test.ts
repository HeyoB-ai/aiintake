import { describe, expect, it } from 'vitest';
import { NullAvatarProvider, NullAvatarSession } from './null-provider';

/**
 * De boekhouding per beurt.
 *
 * Deze tests bestaan om één fout te vangen die maandenlang stil was: de klasse noemde het
 * afsluiten van een beurt `finishTurn`, het contract heet `endTurn`, en de lus riep hem aan
 * als `avatar.endTurn?.()`. Dat optionele vraagteken maakte er een no-op van. Geen
 * typefout, geen melding — de beurt werd nooit afgesloten.
 *
 * Wat er daardoor misging, staat hieronder als twee losse beweringen, want het waren twee
 * losse gevolgen: een meting die leeg bleef, en een truncatie die "alles is gehoord" ging
 * antwoorden.
 */

class Klok {
  t = 0;
  now = (): number => this.t;
  verder(ms: number): void {
    this.t += ms;
  }
}

/** 100 ms audio bij 16 kHz. */
function blok(ms = 100): Int16Array {
  return new Int16Array(Math.round((16_000 * ms) / 1000));
}

describe('first_frame', () => {
  it('vuurt opnieuw na een afgesloten beurt', async () => {
    const klok = new Klok();
    const s = new NullAvatarSession(16_000, klok.now);
    let frames = 0;
    s.on('first_frame', () => {
      frames += 1;
    });

    await s.pushAudio(blok(), 0);
    expect(frames).toBe(1);

    // Nog meer audio in dezelfde beurt: geen tweede frame.
    await s.pushAudio(blok(), 1);
    expect(frames).toBe(1);

    s.endTurn();
    await s.pushAudio(blok(), 2);

    // Dit is de assertie die rood wordt zodra `first_frame` weer per sessie vuurt in plaats
    // van per beurt. Zonder dit blijft `totalResponseLatencyMs` leeg voor elke beurt behalve
    // de opening — en juist de opening meet iets anders, want die heeft geen spraakeinde.
    expect(frames).toBe(2);
  });

  it('vuurt opnieuw na een onderbreking', async () => {
    const klok = new Klok();
    const s = new NullAvatarSession(16_000, klok.now);
    let frames = 0;
    s.on('first_frame', () => {
      frames += 1;
    });

    await s.pushAudio(blok(), 0);
    await s.interrupt();
    await s.pushAudio(blok(), 1);

    expect(frames).toBe(2);
  });
});

describe('spokenMs na een afgesloten beurt', () => {
  it('telt alleen de audio van de lopende beurt', async () => {
    const klok = new Klok();
    const s = new NullAvatarSession(16_000, klok.now);

    // Beurt 1: 2 seconden audio, volledig afgespeeld.
    await s.pushAudio(blok(2000), 0);
    klok.verder(2000);
    s.endTurn();

    // Beurt 2: 400 ms audio, na 150 ms onderbroken.
    await s.pushAudio(blok(400), 1);
    klok.verder(150);
    const { spokenMs } = await s.interrupt();

    /*
     * 150, en niet 2150.
     *
     * Zonder het afsluiten van beurt 1 blijft `playbackStartedAt` op het begin van die
     * beurt staan en telt `bufferedMs` door. `playedMs()` wordt dan het minimum van "alle
     * audio van de sessie" en "de tijd sinds het begin van de sessie" — in dit geval 2400
     * tegen 2150, dus 2150. Dat is meer dan de 400 ms die deze beurt aan audio had, en
     * `truncateToSpoken` geeft bij `spokenMs >= totalMs` de vólledige tekst terug.
     *
     * Het gevolg in het product: vanaf de tweede beurt van elk gesprek legde een barge-in
     * de hele assistent-zin vast als gehoord, inclusief het deel dat middenin werd
     * afgekapt. Precies wat de kop van null-provider.ts belooft te voorkomen.
     */
    expect(spokenMs).toBe(150);
  });

  it('geeft nooit meer terug dan er aan audio in de beurt zat', async () => {
    const klok = new Klok();
    const s = new NullAvatarSession(16_000, klok.now);

    await s.pushAudio(blok(300), 0);
    // Ruim langer wachten dan de audio duurt: de klok mag de buffer niet voorbijlopen.
    klok.verder(5000);
    const { spokenMs } = await s.interrupt();

    expect(spokenMs).toBe(300);
  });

  it('begint een nieuwe beurt op nul, ook zonder onderbreking', async () => {
    const klok = new Klok();
    const s = new NullAvatarSession(16_000, klok.now);

    await s.pushAudio(blok(1000), 0);
    klok.verder(1000);
    s.endTurn();

    // Geen audio in beurt 2, meteen onderbreken: er is niets gehoord.
    const { spokenMs } = await s.interrupt();
    expect(spokenMs).toBe(0);
  });
});

describe('speaking_end', () => {
  it('komt ook bij een normaal beurteinde en niet alleen bij een onderbreking', async () => {
    const klok = new Klok();
    const s = new NullAvatarSession(16_000, klok.now);
    const gebeurtenissen: string[] = [];
    s.on('speaking_start', () => gebeurtenissen.push('start'));
    s.on('speaking_end', () => gebeurtenissen.push('end'));

    await s.pushAudio(blok(), 0);
    s.endTurn();

    expect(gebeurtenissen).toEqual(['start', 'end']);
  });
});

describe('de samplerate waarmee de sessie rekent', () => {
  /*
   * Waarom dit er is.
   *
   * `NullAvatarProvider.createSession()` negeerde zijn opties en construeerde de sessie met
   * een hardgecodeerde 16000. Toen de TTS op 26 augustus 2026 naar 24 kHz ging, bleef dat
   * staan. Niets viel om — beide getallen zijn geldig — maar `bufferedMs` kwam er anderhalf
   * keer te hoog uit. Dat is de bovengrens waarmee `truncateToSpoken` bepaalt wat de cliënt
   * heeft gehoord, dus het transcript ging meer als gehoord vastleggen dan er klonk.
   *
   * Dat is dezelfde klasse als `finishTurn`/`endTurn`: geen fout, geen melding, alleen een
   * getal dat stilletjes niet meer klopt.
   */
  it('rekent bufferedMs op de rate die is meegegeven en niet op 16 kHz', async () => {
    const klok = new Klok();
    const provider = new NullAvatarProvider(klok.now);
    const sessie = (await provider.createSession({
      avatarId: null,
      language: 'nl',
      roomName: null,
      sampleRate: 24_000,
    })) as NullAvatarSession;

    // 24000 samples is één seconde op 24 kHz. Op 16 kHz zou dezelfde buffer 1500 ms "duren".
    sessie.pushAudio(new Int16Array(24_000), 0);
    klok.verder(5_000);

    // playedMs is min(bufferedMs, verstreken tijd). Met 5 seconden verstreken is de buffer
    // de bindende grens, dus dit leest bufferedMs rechtstreeks af.
    const { spokenMs } = await sessie.interrupt();
    expect(spokenMs).toBe(1000);
  });

  it('geeft de opties door en negeert ze niet', async () => {
    // De vorige versie had `_options` in de signatuur: de aanroeper wist de rate wél en gaf
    // hem mee, en de provider gooide hem weg. Deze test faalt als dat terugkomt.
    const klok = new Klok();
    const provider = new NullAvatarProvider(klok.now);
    const sessie = (await provider.createSession({
      avatarId: null,
      language: 'nl',
      roomName: null,
      sampleRate: 8_000,
    })) as NullAvatarSession;

    sessie.pushAudio(new Int16Array(8_000), 0);
    klok.verder(5_000);
    expect((await sessie.interrupt()).spokenMs).toBe(1000);
  });
});
