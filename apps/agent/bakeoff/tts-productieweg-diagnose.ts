import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { TtsAudioChunk, TtsStream } from '@intake/provider-tts';

import { mediaConfigFrom } from '../src/echo-session';
import type { AgentEnv } from '../src/env';
import { maakTtsProvider } from '../src/tts-fabriek';

/**
 * Meet de weg die nu draait, niet de weg die de vergelijking mat.
 *
 * ## Waarom dit apart bestaat naast `diag:tts-vergelijk`
 *
 * Die proef praat rechtstreeks met de API's. Dat was juist voor het kiezen van een
 * leverancier — je wilt dan geen adapter tussen je meting en het antwoord. Maar het is niet
 * wat er in productie gebeurt. Daartussen zitten de fabriek, het wegsnijden van aanloopstilte,
 * het opknippen in chunks, de beurtrotatie en de sample rate uit `TTS_SAMPLE_RATE`.
 *
 * Elk van die stappen kan woorden kosten. Een wissel die op de kale API goed meet en in de
 * keten iets anders doet, is geen wissel maar een verhuizing van het probleem. Deze proef
 * loopt daarom door `mediaConfigFrom` en `maakTtsProvider` — dezelfde twee functies die
 * `startEchoSession` gebruikt.
 *
 * ## Twee beurten, met opzet
 *
 * De tweede beurt is er niet voor het gemiddelde maar omdat hij een ander pad raakt.
 * `turn-loop.ts` roept aan het eind van een schone beurt niets op de TTS aan; de
 * ElevenLabs-adapter roteert zijn context daarom zelf bij de eerste `say()` ná een `flush()`.
 * Die rotatie heeft verder geen dekking. Levert beurt 2 niets of half werk, dan zit het daar.
 *
 * ## Wat er gemeten wordt
 *
 * Hetzelfde als bij de vergelijking, zodat de tabellen naast elkaar te leggen zijn:
 * ontbrekende woorden, woorden die er niet in stonden, en de langste reeks die tweemaal in
 * één transcript staat. Plus wat alleen hier te zien is: hoeveel aanloopstilte de adapter
 * heeft weggesneden, en of er `error`-events zijn geweest.
 *
 * Draaien met: pnpm diag:tts-productieweg
 */

const ZINNEN = [
  'Goedenavond, Heyo Beentje.',
  'Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht.',
  'Ik ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen.',
];
const HEEL = ZINNEN.join(' ');
const RUNS = Number(process.env['RUNS'] ?? 3);

function woorden(tekst: string): string[] {
  return tekst
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/u)
    .filter(Boolean);
}

function ontbreekt(bron: string, gehoord: string): string[] {
  const rest = woorden(gehoord);
  const kwijt: string[] = [];
  for (const w of woorden(bron)) {
    const i = rest.indexOf(w);
    if (i === -1) kwijt.push(w);
    else rest.splice(i, 1);
  }
  return kwijt;
}

const teveel = (bron: string, gehoord: string): string[] => ontbreekt(gehoord, bron);

/** De detector voor een herhaalde staart. Drempel drie woorden; zie diag:tts-vergelijk. */
function langsteHerhaling(gehoord: string): string[] {
  const w = woorden(gehoord);
  const hooiberg = w.join(' ');
  let beste: string[] = [];
  for (let start = 0; start < w.length; start += 1) {
    for (let eind = start + 3; eind <= w.length; eind += 1) {
      const reeks = w.slice(start, eind);
      if (reeks.length <= beste.length) continue;
      const naald = reeks.join(' ');
      const eerste = hooiberg.indexOf(naald);
      if (eerste !== -1 && hooiberg.indexOf(naald, eerste + naald.length) !== -1) beste = reeks;
    }
  }
  return beste;
}

function wav(pcm: Int16Array, rate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const kop = Buffer.alloc(44);
  kop.write('RIFF', 0);
  kop.writeUInt32LE(36 + data.length, 4);
  kop.write('WAVE', 8);
  kop.write('fmt ', 12);
  kop.writeUInt32LE(16, 16);
  kop.writeUInt16LE(1, 20);
  kop.writeUInt16LE(1, 22);
  kop.writeUInt32LE(rate, 24);
  kop.writeUInt32LE(rate * 2, 28);
  kop.writeUInt16LE(2, 32);
  kop.writeUInt16LE(16, 34);
  kop.write('data', 36);
  kop.writeUInt32LE(data.length, 40);
  return Buffer.concat([kop, data]);
}

async function transcribeer(wavBytes: Buffer): Promise<string> {
  const sleutel = process.env['DEEPGRAM_API_KEY'];
  if (!sleutel) throw new Error('DEEPGRAM_API_KEY is nodig voor de rondgang');
  const res = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-3&language=nl&punctuate=true&smart_format=true',
    {
      method: 'POST',
      headers: { Authorization: `Token ${sleutel}`, 'Content-Type': 'audio/wav' },
      body: new Uint8Array(wavBytes),
    },
  );
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
  };
  return body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
}

interface Beurt {
  readonly run: number;
  readonly nummer: number;
  readonly chunks: number;
  readonly ttftMs: number | null;
  readonly duurMs: number;
  readonly gesnedenMs: number;
  readonly gehoord: string;
  readonly kwijt: string[];
  readonly extra: string[];
  readonly herhaling: string[];
  readonly fouten: string[];
}

/** Eén beurt over de stream: drie zinnen erin, wachten op `done`, alles opvangen. */
function spreekBeurt(
  stream: TtsStream,
  fouten: string[],
): Promise<{ chunks: Int16Array[]; ttftMs: number | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Int16Array[] = [];
    let ttftMs: number | null = null;
    const t0 = Date.now();
    const timer = setTimeout(() => reject(new Error('geen "done" binnen 45 s')), 45_000);

    stream.on('audio', (c: TtsAudioChunk) => {
      if (ttftMs === null) ttftMs = Date.now() - t0;
      chunks.push(c.pcm);
    });
    stream.on('done', () => {
      clearTimeout(timer);
      resolve({ chunks, ttftMs });
    });
    /*
     * Fouten verzamelen en niet laten vallen.
     *
     * De adapters sturen hier de bytegrens-melding en de spreektempo-bewaker doorheen. Een
     * proef die die events negeert, kan groen worden terwijl de adapter zelf zegt dat er iets
     * mis is — precies de vorm die dit project vier keer heeft opgeleverd.
     */
    stream.on('error', (e: Error) => fouten.push(String(e.message ?? e)));

    for (const z of ZINNEN) stream.say(z);
    stream.flush();
  });
}

function plak(chunks: Int16Array[]): Int16Array {
  const heel = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    heel.set(c, o);
    o += c.length;
  }
  return heel;
}

async function main(): Promise<void> {
  const env = process.env as Partial<AgentEnv>;
  const media = mediaConfigFrom(env);
  const map = join(process.cwd(), 'measurements', 'tts-productieweg');
  mkdirSync(map, { recursive: true });

  console.log('\n  De productieweg: door de fabriek en de adapter, niet langs de kale API\n');
  console.log(`  leverancier: ${media.tts.keuze}`);
  console.log(`  model:       ${media.tts.model ?? '(standaard van de adapter)'}`);
  console.log(`  stem:        ${media.tts.voiceId}`);
  console.log(`  sample rate: ${media.tts.sampleRate} Hz`);
  console.log(`  tempo:       ${media.tts.speed ?? '(standaard van de adapter)'}`);
  console.log(`  snijden:     ${process.env['TTS_TRIM_LEADING'] === '0' ? 'uit' : 'aan'}`);
  console.log(`  runs:        ${RUNS}, twee beurten per run\n`);

  const beurten: Beurt[] = [];
  const mislukt: string[] = [];

  for (let run = 1; run <= RUNS; run += 1) {
    let stream: TtsStream | null = null;
    try {
      stream = await maakTtsProvider(media.tts).open({
        voiceId: media.tts.voiceId,
        language: 'nl',
        sampleRate: media.tts.sampleRate,
      });

      // Twee beurten over dezelfde stream, want zo loopt een gesprek. De tweede raakt de
      // contextrotatie die de lus zelf niet aanroept.
      for (let nummer = 1; nummer <= 2; nummer += 1) {
        const fouten: string[] = [];
        process.stdout.write(`  run ${run} · beurt ${nummer} … `);
        const { chunks, ttftMs } = await spreekBeurt(stream, fouten);
        const pcm = plak(chunks);
        const gesnedenMs = stream.trimmedLeadingMs?.() ?? 0;
        const wavBytes = wav(pcm, media.tts.sampleRate);
        if (run === 1) writeFileSync(join(map, `${media.tts.keuze}-beurt-${nummer}.wav`), wavBytes);

        const gehoord = pcm.length === 0 ? '' : await transcribeer(wavBytes);
        const beurt: Beurt = {
          run,
          nummer,
          chunks: chunks.length,
          ttftMs,
          duurMs: Math.round((pcm.length / media.tts.sampleRate) * 1000),
          gesnedenMs,
          gehoord,
          kwijt: pcm.length === 0 ? woorden(HEEL) : ontbreekt(HEEL, gehoord),
          extra: pcm.length === 0 ? [] : teveel(HEEL, gehoord),
          herhaling: langsteHerhaling(gehoord),
          fouten,
        };
        beurten.push(beurt);
        console.log(
          `${beurt.duurMs} ms, ${beurt.kwijt.length} kwijt, ${beurt.extra.length} extra` +
            `${fouten.length > 0 ? `, ${fouten.length} fout(en)` : ''}`,
        );
      }
    } catch (e) {
      mislukt.push(`run ${run}: ${String(e).slice(0, 200)}`);
      console.log('MISLUKT');
    } finally {
      await stream?.close();
    }
  }

  /*
   * Een proef die niets heeft gemeten, zegt dat als eerste. Een lege tabel met een nette
   * samenvatting eronder is de vorm waarin een mislukte meting eruitziet als een resultaat.
   */
  if (beurten.length === 0) {
    console.log('\n  GEEN ENKELE BEURT GELUKT. Er valt hieronder niets te concluderen.\n');
    for (const m of mislukt) console.log(`    ${m}`);
    console.log('');
    process.exitCode = 1;
    return;
  }

  const kop = [
    'run'.padStart(3),
    'beurt'.padStart(5),
    'duur'.padStart(8),
    'TTFT'.padStart(6),
    'gesneden'.padStart(9),
    'chunks'.padStart(7),
    'kwijt'.padStart(6),
    'extra'.padStart(6),
    'herhaald'.padStart(9),
  ].join(' ');
  console.log(`\n  ${kop}`);
  console.log(`  ${'-'.repeat(kop.length)}`);
  for (const b of beurten) {
    console.log(
      `  ${[
        String(b.run).padStart(3),
        String(b.nummer).padStart(5),
        `${b.duurMs} ms`.padStart(8),
        (b.ttftMs === null ? '—' : `${b.ttftMs} ms`).padStart(6),
        `${b.gesnedenMs} ms`.padStart(9),
        String(b.chunks).padStart(7),
        String(b.kwijt.length).padStart(6),
        String(b.extra.length).padStart(6),
        String(b.herhaling.length || '').padStart(9),
      ].join(' ')}`,
    );
  }

  if (mislukt.length > 0) {
    console.log(`\n  ${mislukt.length} run(s) mislukt — die staan niet in de tabel:`);
    for (const m of mislukt) console.log(`    ${m}`);
  }

  console.log('\n  Wat de herkenner terugkreeg\n');
  for (const b of beurten) {
    console.log(`  run ${b.run} · beurt ${b.nummer}`);
    console.log(`    ${b.gehoord || '(niets)'}`);
    if (b.kwijt.length > 0) console.log(`    KWIJT (${b.kwijt.length}): ${b.kwijt.join(' ')}`);
    if (b.extra.length > 0) console.log(`    EXTRA (${b.extra.length}): ${b.extra.join(' ')}`);
    if (b.herhaling.length > 0) {
      console.log(`    HERHAALD (${b.herhaling.length}): ${b.herhaling.join(' ')}`);
    }
    for (const f of b.fouten) console.log(`    FOUT VAN DE ADAPTER: ${f}`);
    console.log('');
  }

  // ------------------------------------------------------------------ het oordeel
  const disclaimer = beurten.filter((b) => !b.gehoord.toLowerCase().includes('geen advocaat'));
  const groet = beurten.filter((b) => !b.gehoord.toLowerCase().includes('goedenavond'));
  const herhaald = beurten.filter((b) => b.herhaling.length > 0);
  const tweede = beurten.filter((b) => b.nummer === 2 && b.duurMs === 0);
  const fouten = beurten.flatMap((b) => b.fouten);

  console.log('  Wat hier uitkomt, naast de tabel van diag:tts-vergelijk\n');
  console.log(`    metingen:                      ${beurten.length}`);
  console.log(`    "Goedenavond" weg:             ${groet.length}`);
  console.log(`    "geen advocaat" weg:           ${disclaimer.length}`);
  console.log(`    herhaalde reeks van 3+:        ${herhaald.length}`);
  console.log(`    tweede beurt zonder audio:     ${tweede.length}`);
  console.log(`    foutmeldingen van de adapter:  ${fouten.length}`);

  if (tweede.length > 0) {
    console.log('\n    De tweede beurt leverde niets. Dat is de contextrotatie: de lus roept');
    console.log('    er niets voor aan en de adapter hoort het zelf te doen. Zie risico 18.');
  }
  if (disclaimer.length > 0) {
    console.log('\n    DE DISCLAIMER ONTBREEKT IN MINSTENS ÉÉN BEURT. Dat is de zin waarvoor de');
    console.log('    cliënt op het toestemmingsscherm tekent. Zie risico 17.');
  }
  console.log(`\n  WAV's van run 1 staan in ${map}\n`);
}

main().catch((e: unknown) => {
  console.error('\n  proef mislukt:', e);
  process.exitCode = 1;
});
