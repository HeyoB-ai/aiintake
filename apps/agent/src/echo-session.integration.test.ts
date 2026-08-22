import { describe, expect, it } from 'vitest';
import { CartesiaTtsProvider, type CartesiaTtsStream } from '@intake/provider-tts';
import { startEchoSession, type MediaConfig } from './echo-session';
import { paceAudio, pacingDrift } from './test-support/pace-audio';
import { formatHudLine, hudRows } from './metrics';
import type { CompletedTurn } from './turn-loop';

/**
 * De volledige lus, met echte leveranciers.
 *
 * Dit is het eerste totaalcijfer van het project: spraakeinde tot een avatar die praat.
 * Alle losse stappen waren al gemeten; hier komen ze samen, inclusief de stapelfouten
 * die je in losse metingen niet ziet.
 *
 * De "cliënt" is Cartesia met een andere stem — er is geen microfoon in een testrun. Dat
 * maakt de meting reproduceerbaar maar ook optimistisch: synthetische spraak heeft een
 * schoon zinseinde, en juist daar valt endpointing over. Zie ADR-0009.
 */

const KEYS = ['DEEPGRAM_API_KEY', 'CARTESIA_API_KEY', 'CARTESIA_VOICE_ID'] as const;
const missing = KEYS.filter((k) => !process.env[k]);
const describeLive = missing.length === 0 ? describe : describe.skip;

if (missing.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(`\n[echo] OVERGESLAGEN — ontbreekt: ${missing.join(', ')}\n`);
}

const SAMPLE_RATE = 16_000;
const UITSPRAAK = 'Ik kreeg gisteren een vaststellingsovereenkomst van mijn werkgever.';

/** Synthetiseert de cliëntzin, zodat er iets is om de STT mee te voeden. */
async function spreek(text: string): Promise<Int16Array> {
  const tts = new CartesiaTtsProvider({ apiKey: process.env['CARTESIA_API_KEY']! });
  const stream = (await tts.open({
    voiceId: process.env['CARTESIA_VOICE_ID']!,
    language: 'nl',
    sampleRate: SAMPLE_RATE,
  })) as CartesiaTtsStream;

  const chunks: Int16Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthese liep vast')), 30_000);
    stream.on('audio', (c) => chunks.push(c.pcm));
    stream.on('done', () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    stream.say(text);
    stream.flush();
  });
  await stream.close();

  const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    pcm.set(c, offset);
    offset += c.length;
  }
  return pcm;
}

describeLive('echo-agent over de echte keten', () => {
  it('doet een volledige beurt en meet het totaal', async () => {
    const pcm = await spreek(UITSPRAAK);

    const turns: CompletedTurn[] = [];
    const media: MediaConfig = {
      deepgramApiKey: process.env['DEEPGRAM_API_KEY']!,
      cartesiaApiKey: process.env['CARTESIA_API_KEY']!,
      cartesiaVoiceId: process.env['CARTESIA_VOICE_ID']!,
    };
    const session = await startEchoSession({ media, onTurn: (turn) => turns.push(turn) });

    const klaar = new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (turns.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 50);
      setTimeout(() => {
        clearInterval(check);
        resolve();
      }, 40_000);
    });

    // Op ware snelheid aanleveren, met driftcompensatie. Zonder dat loopt de stream
    // achter op de wandklok en meet je die achterstand als endpointing-latency.
    const feedStart = performance.now();
    await paceAudio(pcm, {
      sampleRate: SAMPLE_RATE,
      onFrame: (frame) => session.pushAudio(frame),
    });
    const drift = pacingDrift(pcm, SAMPLE_RATE, performance.now() - feedStart);
    session.finaliseInput();

    await klaar;
    await session.close();

    expect(turns).toHaveLength(1);
    const turn = turns[0]!;

    // eslint-disable-next-line no-console
    console.log(
      `\n  aanlevering   ${drift >= 0 ? '+' : ''}${drift} ms drift t.o.v. ware snelheid\n` +
        `  cliënt zei:   "${turn.clientUtterance}"\n` +
        `  assistent:    "${turn.assistantContent}"\n` +
        `  HUD           ${formatHudLine(turn.metrics)}\n`,
    );
    for (const row of hudRows(turn.metrics)) {
      // eslint-disable-next-line no-console
      console.log(
        `    ${row.label.padEnd(20)} ${String(row.value ?? '—').padStart(6)} ms   ` +
          `budget p50 ${row.p50} / p95 ${row.p95}   ${row.status}`,
      );
    }

    // De echo bewijst dat de transcriptie door de lus is gekomen.
    expect(turn.assistantContent).toContain('U zei:');
    expect(turn.clientUtterance.toLowerCase()).toContain('vaststellingsovereenkomst');

    if (turn.clientUtteranceWasCut) {
      // De STT kapte de cliënt af (RISICOS.md risico 2). De lus breekt het antwoord dan
      // bewust af — een half gehoorde vraag hoort niet zelfverzekerd beantwoord te
      // worden. Het antwoord is dus korter, en dat is het gewenste gedrag.
      //
      // Wat hier wél moet kloppen: de volledige uitspraak is alsnog hersteld.
      expect(turn.clientUtterance.trim().endsWith('werkgever.')).toBe(true);
    } else {
      expect(turn.assistantContent.toLowerCase()).toContain('vaststellingsovereenkomst');
      expect(turn.metrics.wasInterrupted).toBe(false);
    }

    // Elke stap moet gemeten zijn. Een streepje hier betekent dat de keten ergens
    // doorliep zonder op de vorige stap te wachten.
    expect(turn.metrics.speechEndToSttFinalMs).not.toBeNull();
    expect(turn.metrics.sttToLlmFirstTokenMs).not.toBeNull();
    expect(turn.metrics.llmToTtsFirstAudioMs).not.toBeNull();
    expect(turn.metrics.ttsToAvatarFirstFrameMs).not.toBeNull();

    // Loopt de aanlevering achter, dan is de endpointing-meting vertekend en zegt het
    // totaal niets. Liever een falende test dan een mooi getal dat nergens op slaat.
    expect(Math.abs(drift)).toBeLessThan(150);

    // De Fase 1-poort. Op de null-provider ontbreekt de rendertijd van een echte
    // avatar, dus dit is een ondergrens — maar zit hij hier al boven, dan gaat de
    // bakeoff het zeker niet halen.
    expect(turn.metrics.totalResponseLatencyMs!).toBeLessThan(1500);
  }, 90_000);
});
