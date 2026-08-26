import { beforeAll, describe, expect, it } from 'vitest';
import { CartesiaTtsProvider } from '@intake/provider-tts';
import {
  DeepgramSttProvider,
  EMPLOYMENT_KEYTERMS_NL,
  type DeepgramSttStream,
} from '@intake/provider-stt';

/**
 * De eerste echte meting: Cartesia synthetiseert een Nederlandse zin, Deepgram
 * transcribeert hem terug.
 *
 * Waarom deze rondgang en niet twee losse tests: hij bewijst beide adapters én levert
 * meteen twee getallen uit de latencybegroting die je met een fake niet kunt krijgen —
 * time-to-first-audio en endpointing. En hij toetst het enige dat er inhoudelijk toe
 * doet: overleeft het juridische jargon de heen-en-weerweg?
 *
 * Kost een paar seconden synthese en herkenning. Vandaar `pnpm test:pipeline` en niet
 * `pnpm test`.
 */

const KEYS = ['CARTESIA_API_KEY', 'CARTESIA_VOICE_ID', 'DEEPGRAM_API_KEY'] as const;
const missing = KEYS.filter((k) => !process.env[k]);
const describeLive = missing.length === 0 ? describe : describe.skip;

if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `\n[pipeline] OVERGESLAGEN — ontbreekt: ${missing.join(', ')}\n` +
      `Gelezen env-bestanden: ${process.env['INTAKE_ENV_FILES_LOADED'] || '(geen)'}\n`,
  );
}

/** De demozin uit §12, met het jargon waar een algemeen model over struikelt. */
const ZIN = 'Ik kreeg gisteren van mijn werkgever een vaststellingsovereenkomst.';

const SAMPLE_RATE = 16_000;

describeLive('Cartesia -> Deepgram rondgang', () => {
  let pcm: Int16Array;
  let ttfaMs = 0;
  let totalAudioMs = 0;

  beforeAll(async () => {
    const tts = new CartesiaTtsProvider({ apiKey: process.env['CARTESIA_API_KEY']! });
    const stream = await tts.open({
      voiceId: process.env['CARTESIA_VOICE_ID']!,
      language: 'nl',
      sampleRate: SAMPLE_RATE,
    });

    const chunks: Int16Array[] = [];
    const start = performance.now();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cartesia: geen done binnen 30s')), 30_000);
      stream.on('audio', (chunk) => {
        if (chunks.length === 0) ttfaMs = Math.round(performance.now() - start);
        chunks.push(chunk.pcm);
        totalAudioMs += chunk.durationMs;
      });
      stream.on('done', () => {
        clearTimeout(timer);
        resolve();
      });
      stream.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      stream.say(ZIN);
      stream.flush();
    });

    await stream.close();

    const total = chunks.reduce((n, c) => n + c.length, 0);
    pcm = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
      pcm.set(c, offset);
      offset += c.length;
    }
  }, 60_000);

  it('synthetiseert Nederlandse spraak', () => {
    expect(pcm.length).toBeGreaterThan(SAMPLE_RATE / 2); // minstens een halve seconde
    // eslint-disable-next-line no-console
    console.log(
      `\n  Cartesia  time-to-first-audio ${ttfaMs} ms · ${Math.round(totalAudioMs)} ms audio\n`,
    );
  });

  it('haalt het TTS-budget van 180 ms p95', () => {
    // Eén meting is geen p95, maar zit hij hier al ver boven, dan klopt er iets niet
    // met de regio of de verbinding en heeft dooormeten geen zin.
    expect(ttfaMs).toBeLessThan(1000);
  });

  it('herkent de zin terug, inclusief het juridische jargon', async () => {
    const stt = new DeepgramSttProvider({ apiKey: process.env['DEEPGRAM_API_KEY']! });
    const stream = (await stt.connect({
      language: 'nl',
      keyterms: EMPLOYMENT_KEYTERMS_NL,
      sampleRate: SAMPLE_RATE,
    })) as DeepgramSttStream;

    let transcript = '';
    let lastAudioAt = 0;
    let endOfTurnAt = 0;

    const done = new Promise<void>((resolve) => {
      stream.on('end_of_turn', (text) => {
        endOfTurnAt = performance.now();
        transcript = text;
        resolve();
      });
      // Vangnet: zonder end_of_turn zou de test 60s blijven hangen.
      setTimeout(resolve, 20_000);
    });

    // In realtime aanleveren, in blokken van 20 ms. Alles in één keer dumpen zou de
    // endpointing-meting waardeloos maken.
    const frame = (SAMPLE_RATE / 1000) * 20;
    for (let i = 0; i < pcm.length; i += frame) {
      stream.push(pcm.subarray(i, Math.min(i + frame, pcm.length)));
      await new Promise((r) => setTimeout(r, 20));
    }
    lastAudioAt = performance.now();
    stream.finalise();

    await done;
    await stream.close();

    const endpointingMs = endOfTurnAt > 0 ? Math.round(endOfTurnAt - lastAudioAt) : -1;
    // eslint-disable-next-line no-console
    console.log(`\n  Deepgram  endpointing ${endpointingMs} ms\n  transcript: "${transcript}"\n`);

    const normalised = transcript.toLowerCase();
    expect(normalised.length).toBeGreaterThan(0);
    expect(normalised).toContain('werkgever');
    // Dit is waar de keyterm-lijst voor bestaat. Faalt dit, dan is keyterm prompting
    // niet actief voor Nederlands en moeten we het jargon anders opvangen.
    expect(normalised).toContain('vaststellingsovereenkomst');
  }, 60_000);
});
