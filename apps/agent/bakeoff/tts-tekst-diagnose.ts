import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * Spreekt Cartesia alles uit wat wij aanleveren?
 *
 * ## De aanleiding
 *
 * `rauw.wav` — buiten onze adapter om, buiten Anam om — is met de hand getranscribeerd.
 * Verstuurd ging er dit in:
 *
 *   "Goedenavond, Heyo Beentje. Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht.
 *    Ik ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen."
 *
 * Eruit kwam dit:
 *
 *   "Heyo Beentje, ik ben AI intake assistent van van dijk arbeidsrecht.
 *    Ik ben arbeidsrecht om de gegevens van uw zaak vast te leggen."
 *
 * "Goedenavond" weg aan het begin, en midden in de derde zin valt "geen advocaat en ben
 * aangesteld" weg waarna de rest aan elkaar wordt geplakt. Dat is geen vervorming en geen
 * uitlijning: er ontbreekt tekst.
 *
 * **En de zin die wegvalt is de disclaimer.** Zie RISICOS.md risico 17.
 *
 * ## Wat deze proef vergelijkt
 *
 * Drie armen op exact dezelfde tekst, met één ijkpunt:
 *
 *   REST      /tts/bytes in één aanroep. Geen streaming, geen contexten. Dit is de
 *             grondwaarheid: zo lang hoort deze zin te duren.
 *   WS-heel   één bericht over de WebSocket, `continue: false`.
 *   WS-perzin zoals de adapter het in productie doet: `say()` per zin met
 *             `continue: true`, daarna `flush()`.
 *
 * ## Waarom duur niet de maat is
 *
 * De eerste opzet vergeleek alleen de duur van de drie armen. Twee runs later bleek dat
 * onbruikbaar: REST zelf leverde 9520 ms en daarna 7848 ms op exact dezelfde tekst, een
 * verschil van 18 procent. De spreiding binnen één arm is groter dan het verschil tussen de
 * armen, dus een korter fragment bewijst niets over ontbrekende woorden.
 *
 * Daarom een rondgang: elke arm gaat door Deepgram en het teruggekomen transcript wordt
 * woord voor woord met de invoer vergeleken. Dat is machinaal na te kijken en herhaalbaar,
 * en het meet wat er werkelijk toe doet — of de woorden er zijn.
 *
 * De duur staat er nog bij, maar als context en niet als oordeel.
 *
 * Elk bericht dat de socket in gaat, wordt letterlijk gelogd. Zonder dat is "wat kreeg
 * Cartesia" een aanname.
 *
 * Draaien met: pnpm diag:tts-tekst
 */

const WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const REST_URL = 'https://api.cartesia.ai/tts/bytes';
const API_VERSION = '2025-04-16';
const SAMPLE_RATE = 16_000;

const ZINNEN = [
  'Goedenavond, Heyo Beentje.',
  'Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht.',
  'Ik ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen.',
];
const HEEL = ZINNEN.join(' ');

const apiKey = process.env['CARTESIA_API_KEY'];
const voiceId = process.env['CARTESIA_VOICE_ID'];
const model = process.env['CARTESIA_MODEL'] ?? 'sonic-3';
if (!apiKey || !voiceId) throw new Error('CARTESIA_API_KEY en CARTESIA_VOICE_ID zijn nodig');

const uitvoer = { container: 'raw', encoding: 'pcm_s16le', sample_rate: SAMPLE_RATE } as const;

function wav(pcm: Int16Array): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const kop = Buffer.alloc(44);
  kop.write('RIFF', 0);
  kop.writeUInt32LE(36 + data.length, 4);
  kop.write('WAVE', 8);
  kop.write('fmt ', 12);
  kop.writeUInt32LE(16, 16);
  kop.writeUInt16LE(1, 20);
  kop.writeUInt16LE(1, 22);
  kop.writeUInt32LE(SAMPLE_RATE, 24);
  kop.writeUInt32LE(SAMPLE_RATE * 2, 28);
  kop.writeUInt16LE(2, 32);
  kop.writeUInt16LE(16, 34);
  kop.write('data', 36);
  kop.writeUInt32LE(data.length, 40);
  return Buffer.concat([kop, data]);
}

const duurMs = (bytes: number) => Math.round((bytes / 2 / SAMPLE_RATE) * 1000);

/** Woorden, kleingeletterd en zonder leestekens. Voor het vergelijken van tekst. */
function woorden(tekst: string): string[] {
  return tekst
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/u)
    .filter(Boolean);
}

/**
 * De audio terug door de spraakherkenner.
 *
 * Deepgram's prerecorded-endpoint accepteert een WAV rechtstreeks. Dat is genoeg: we
 * vergelijken woorden, niet tijdstempels.
 */
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

/**
 * Welke woorden uit de invoer ontbreken in het transcript?
 *
 * Volgorde-gevoelig en met multiset-semantiek: een woord dat twee keer wordt gezegd en één
 * keer terugkomt, telt als één ontbrekend woord. De herkenner maakt eigen fouten -- "AI"
 * wordt "a i" -- dus dit is een aanwijzing en geen bewijs. Een enkel woord verschil is ruis;
 * een aaneengesloten reeks van vijf is dat niet.
 */
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

async function viaRest(tekst: string): Promise<Buffer> {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey!,
      'Cartesia-Version': API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: model,
      transcript: tekst,
      voice: { mode: 'id', id: voiceId },
      language: 'nl',
      output_format: uitvoer,
    }),
  });
  if (!res.ok) throw new Error(`REST HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Eén WebSocket-arm.
 *
 * `berichten` is precies wat er de socket in gaat, in volgorde. Ze worden gelogd voordat ze
 * verstuurd worden, zodat er geen verschil kan bestaan tussen wat we denken te sturen en
 * wat er gaat.
 */
async function viaWs(naam: string, berichten: Record<string, unknown>[]): Promise<Buffer> {
  const socket = new WebSocket(
    `${WS_URL}?api_key=${encodeURIComponent(apiKey!)}&cartesia_version=${API_VERSION}`,
  );
  await new Promise<void>((klaar, mis) => {
    socket.on('open', () => klaar());
    socket.on('error', mis);
  });

  const chunks: Buffer[] = [];
  let dones = 0;
  const klaar = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${naam}: geen "done" binnen 40 s`)), 40_000);
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { type?: string; data?: string; error?: string };
      if (m.type === 'chunk' && m.data) chunks.push(Buffer.from(m.data, 'base64'));
      else if (m.type === 'done') {
        dones += 1;
        clearTimeout(t);
        resolve();
      } else if (m.type === 'error') {
        clearTimeout(t);
        reject(new Error(`${naam}: ${m.error ?? 'onbekend'}`));
      }
    });
  });

  for (const b of berichten) {
    console.log(`    → ${JSON.stringify({ ...b, voice: '…', output_format: '…' })}`);
    socket.send(JSON.stringify(b));
  }

  await klaar;
  // Even nawachten: een "done" die vóór de laatste chunk aankomt zou de meting bekorten,
  // en dat mag niet als artefact van dit harnas ontstaan.
  await new Promise((r) => setTimeout(r, 750));
  socket.close();

  console.log(`    ${chunks.length} chunks · ${dones} keer "done"`);
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  console.log('\n  Spreekt Cartesia alles uit wat wij aanleveren?\n');
  console.log(`  tekst (${HEEL.length} tekens): ${HEEL}\n`);

  const map = join(process.cwd(), 'measurements');
  mkdirSync(map, { recursive: true });

  console.log('  [1/3] REST, in één aanroep — het ijkpunt');
  const rest = await viaRest(HEEL);
  writeFileSync(
    join(map, 'tekst-rest.wav'),
    wav(new Int16Array(rest.buffer, rest.byteOffset, rest.length / 2)),
  );
  console.log(`    ${rest.length} bytes · ${duurMs(rest.length)} ms\n`);

  const ctx1 = `diag-heel-${Date.now()}`;
  console.log('  [2/3] WebSocket, één bericht');
  const wsHeel = await viaWs('ws-heel', [
    {
      model_id: model,
      transcript: HEEL,
      voice: { mode: 'id', id: voiceId },
      language: 'nl',
      output_format: uitvoer,
      context_id: ctx1,
      continue: false,
    },
  ]);
  writeFileSync(
    join(map, 'tekst-ws-heel.wav'),
    wav(new Int16Array(wsHeel.buffer, wsHeel.byteOffset, wsHeel.length / 2)),
  );
  console.log(`    ${wsHeel.length} bytes · ${duurMs(wsHeel.length)} ms\n`);

  const ctx2 = `diag-perzin-${Date.now()}`;
  console.log('  [3/3] WebSocket, per zin — zoals de adapter het doet');
  const wsPerZin = await viaWs('ws-perzin', [
    ...ZINNEN.map((z) => ({
      model_id: model,
      transcript: z,
      // Let op: de adapter stuurt `voice: { id }` zonder `mode`. Hier hetzelfde, zodat
      // deze arm het productiegedrag nabootst en niet een verbeterde versie ervan.
      voice: { id: voiceId },
      language: 'nl',
      output_format: uitvoer,
      context_id: ctx2,
      continue: true,
    })),
    {
      model_id: model,
      transcript: '',
      voice: { id: voiceId },
      language: 'nl',
      output_format: uitvoer,
      context_id: ctx2,
      continue: false,
    },
  ]);
  writeFileSync(
    join(map, 'tekst-ws-perzin.wav'),
    wav(new Int16Array(wsPerZin.buffer, wsPerZin.byteOffset, wsPerZin.length / 2)),
  );
  console.log(`    ${wsPerZin.length} bytes · ${duurMs(wsPerZin.length)} ms\n`);

  // ----------------------------------------------------- de rondgang
  console.log('  Rondgang: elke arm terug door Deepgram');
  console.log('');

  const armen: { naam: string; buf: Buffer }[] = [
    { naam: 'REST', buf: rest },
    { naam: 'ws-heel', buf: wsHeel },
    { naam: 'ws-perzin', buf: wsPerZin },
  ];

  let iemandMistTekst = false;
  for (const { naam, buf } of armen) {
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
    const gehoord = await transcribeer(wav(pcm));
    const kwijt = ontbreekt(HEEL, gehoord);
    console.log(`  ${naam} (${duurMs(buf.length)} ms)`);
    console.log(`    gehoord: ${gehoord}`);
    console.log(
      kwijt.length === 0
        ? '    alle woorden terug'
        : `    ONTBREEKT (${kwijt.length}): ${kwijt.join(' ')}`,
    );
    console.log('');
    if (kwijt.length > 2) iemandMistTekst = true;
  }

  if (iemandMistTekst) {
    console.log('  Er ontbreekt tekst. Luister de WAV-bestanden in measurements/ om te');
    console.log('  horen waar de naad zit; het transcript zegt welke woorden.');
  } else {
    console.log('  Geen arm mist meer dan twee woorden. Wat er ontbreekt is dan eerder');
    console.log('  een fout van de herkenner dan van de synthese — vergelijk met het oor.');
  }
  console.log('');
}

main().catch((e: unknown) => {
  console.error('\n  diagnose mislukt:', e);
  process.exitCode = 1;
});
