import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * Waarom klinkt de openingszin onduidelijk?
 *
 * ## De twee verdachten
 *
 * **1. Byte-uitlijning.** `CartesiaTtsStream.onMessage` doet dit:
 *
 *     const bytes = Buffer.from(message.data, 'base64');
 *     const ruw = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
 *
 * Twee aannames zitten daarin, en geen van beide is gegarandeerd:
 *
 *  - dat `bytes.byteOffset` even is. Node geeft een Buffer uit een gedeelde pool; is de
 *    offset oneven, dan gooit `new Int16Array` een RangeError. De chunk is dan weg.
 *  - dat `bytes.length` even is. Is hij oneven, dan valt de laatste byte onder tafel en
 *    begint de vólgende chunk op de verkeerde bytegrens. Vanaf dat moment worden twee
 *    helften van verschillende samples aan elkaar geplakt, en dat is geen subtiele
 *    vervorming maar ruis. Precies "onverstaanbaar".
 *
 * Dat laatste zou intermitterend zijn — het hangt aan waar de leverancier zijn chunks
 * knipt — en dat past bij "soms begon ze onduidelijk".
 *
 * **2. Het wegsnijden van aanloopstilte.** p50 204 ms per beurt. De drempel staat op
 * 0,003, er blijft 20 ms aanloop staan en er gaat 8 ms fade-in overheen. Snijdt hij te
 * diep, dan mist de eerste medeklinker.
 *
 * ## Wat deze proef doet
 *
 * Hij praat rechtstreeks met de Cartesia-WebSocket, buiten onze adapter om, en meet wat
 * er werkelijk binnenkomt:
 *
 *  - hoeveel chunks, en hoeveel daarvan een oneven aantal bytes hebben;
 *  - hoeveel bytes er bij onze huidige verwerking verloren gaan;
 *  - waar het eerste hoorbare sample zit, en hoeveel de trimmer zou wegsnijden.
 *
 * En hij schrijft drie WAV-bestanden weg, zodat je het verschil kunt hóren in plaats van
 * afleiden uit een getal:
 *
 *     rauw.wav      alle bytes correct aaneengeschakeld
 *     onzeweg.wav   zoals onze adapter hem vandaag opbouwt, per chunk
 *     gesneden.wav  onzeweg.wav plus het wegsnijden van de aanloop
 *
 * Klinkt `rauw.wav` goed en `onzeweg.wav` niet, dan is het de uitlijning. Klinken die twee
 * gelijk en `gesneden.wav` niet, dan is het de trimmer.
 *
 * Draaien met: pnpm diag:audio
 */

const WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const API_VERSION = '2025-04-16';
const SAMPLE_RATE = 16_000;

/** Dezelfde zin waarmee het live misging. */
const ZIN =
  'Goedenavond, Heyo Beentje. Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht. ' +
  'Ik ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen.';

const AUDIBLE_THRESHOLD = 0.003;
const KEEP_LEAD_MS = 20;

const apiKey = process.env['CARTESIA_API_KEY'];
const voiceId = process.env['CARTESIA_VOICE_ID'];
if (!apiKey || !voiceId) throw new Error('CARTESIA_API_KEY en CARTESIA_VOICE_ID zijn nodig');

/** Minimale WAV-kop voor 16-bit mono PCM. */
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

async function main(): Promise<void> {
  console.log('\n  Audio-diagnose: uitlijning en aanloopsnijden\n');

  const socket = new WebSocket(
    `${WS_URL}?api_key=${encodeURIComponent(apiKey!)}&cartesia_version=${API_VERSION}`,
  );
  await new Promise<void>((klaar, mis) => {
    socket.on('open', () => klaar());
    socket.on('error', (e) => mis(e));
  });

  const chunks: Buffer[] = [];
  const klaar = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('geen "done" binnen 40 s')), 40_000);
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { type?: string; data?: string; error?: string };
      if (m.type === 'chunk' && m.data) chunks.push(Buffer.from(m.data, 'base64'));
      else if (m.type === 'done') {
        clearTimeout(t);
        resolve();
      } else if (m.type === 'error') {
        clearTimeout(t);
        reject(new Error(m.error ?? 'onbekende fout'));
      }
    });
  });

  socket.send(
    JSON.stringify({
      model_id: process.env['CARTESIA_MODEL'] ?? 'sonic-3',
      transcript: ZIN,
      voice: { mode: 'id', id: voiceId },
      language: 'nl',
      context_id: `diag-${Date.now()}`,
      continue: false,
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: SAMPLE_RATE,
      },
    }),
  );

  await klaar;
  socket.close();

  // ---------------------------------------------------------------- meting 1
  const oneven = chunks.filter((c) => c.length % 2 !== 0);
  const onevenOffset = chunks.filter((c) => c.byteOffset % 2 !== 0);
  const totaalBytes = chunks.reduce((n, c) => n + c.length, 0);
  const onzeBytes = chunks.reduce((n, c) => n + Math.floor(c.length / 2) * 2, 0);

  console.log(`  chunks:                 ${chunks.length}`);
  console.log(`  bytes totaal:           ${totaalBytes}`);
  console.log(`  chunks met oneven lengte: ${oneven.length}`);
  console.log(`  chunks met oneven offset: ${onevenOffset.length}`);
  console.log(`  bytes die wij weggooien:  ${totaalBytes - onzeBytes}`);
  if (oneven.length > 0) {
    console.log(
      `\n  UITLIJNING: vanaf de eerste oneven chunk staat elke volgende sample een byte\n` +
        `  verschoven. Dat is ruis, geen vervorming.\n`,
    );
  }

  // ---------------------------------------------------------------- de drie bestanden
  const heel = Buffer.concat(chunks);
  const rauw = new Int16Array(
    heel.buffer.slice(heel.byteOffset, heel.byteOffset + Math.floor(heel.length / 2) * 2),
  );

  // Zoals onze adapter het vandaag doet: per chunk, met de restbyte eraf.
  const perChunk: Int16Array[] = [];
  for (const c of chunks) {
    const aantal = Math.floor(c.length / 2);
    const kopie = Buffer.from(c.subarray(0, aantal * 2)); // eigen buffer: altijd uitgelijnd
    perChunk.push(new Int16Array(kopie.buffer, kopie.byteOffset, aantal));
  }
  const onzeweg = new Int16Array(perChunk.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of perChunk) {
    onzeweg.set(p, o);
    o += p.length;
  }

  // ---------------------------------------------------------------- meting 2
  const grens = AUDIBLE_THRESHOLD * 32767;
  let eerste = 0;
  while (eerste < rauw.length && Math.abs(rauw[eerste]!) <= grens) eerste += 1;
  const lead = Math.round((KEEP_LEAD_MS / 1000) * SAMPLE_RATE);
  const vanaf = Math.max(0, eerste - lead);
  const gesneden = rauw.slice(vanaf);

  console.log(
    `  eerste hoorbare sample: ${eerste} (${((eerste / SAMPLE_RATE) * 1000).toFixed(0)} ms)`,
  );
  console.log(`  zou worden weggesneden: ${((vanaf / SAMPLE_RATE) * 1000).toFixed(0)} ms`);
  console.log(`  duur totaal:            ${((rauw.length / SAMPLE_RATE) * 1000).toFixed(0)} ms`);

  const map = join(process.cwd(), 'measurements');
  mkdirSync(map, { recursive: true });
  writeFileSync(join(map, 'rauw.wav'), wav(rauw, SAMPLE_RATE));
  writeFileSync(join(map, 'onzeweg.wav'), wav(onzeweg, SAMPLE_RATE));
  writeFileSync(join(map, 'gesneden.wav'), wav(gesneden, SAMPLE_RATE));

  console.log(`\n  Geschreven naar ${map}:`);
  console.log('    rauw.wav      alle bytes correct aaneengeschakeld');
  console.log('    onzeweg.wav   zoals onze adapter hem opbouwt');
  console.log('    gesneden.wav  met het wegsnijden van de aanloop\n');
  console.log('  Luister ze in deze volgorde. Wijkt onzeweg af van rauw, dan is het de');
  console.log('  uitlijning. Wijkt alleen gesneden af, dan is het de trimmer.\n');
}

main().catch((e: unknown) => {
  console.error('\n  diagnose mislukt:', e);
  process.exitCode = 1;
});
