import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

/**
 * Cartesia naast ElevenLabs, met dezelfde rondgang die risico 17 heeft aangetoond.
 *
 * ## Waarom deze proef bestaat
 *
 * Risico 17: Cartesia laat op onze openingszin de eerste zin vallen en herhaalt de staart.
 * De vraag is of dat aan de leverancier ligt of aan het Nederlands, en het antwoord daarop
 * is alleen te geven door een tweede leverancier dezelfde tekst te laten zeggen.
 *
 * ## Het meetprincipe
 *
 * Synthetiseren, terug door Deepgram, transcript woord voor woord tegen de invoer. Duur is
 * bewust géén maat: bij Cartesia gaf REST 9520 ms en daarna 7848 ms op exact dezelfde
 * tekst — 18 procent spreiding binnen één arm, groter dan het verschil tussen de armen.
 *
 * ## Wat er anders is dan bij `diag:tts-tekst`
 *
 * Daar telde alleen wat er ontbrak. De herhaalde staart bij Cartesia heb ik met het oog uit
 * het transcript gehaald, en dat is precies de soort waarneming die de volgende keer wordt
 * gemist. Hier wordt hij gemeten:
 *
 *   ontbreekt()        woorden uit de bron die niet terugkomen
 *   teveel()           woorden in het transcript die niet in de bron staan
 *   langsteHerhaling() de langste aaneengesloten reeks die tweemaal in het transcript staat
 *
 * Die derde is de eigenlijke detector voor "de staart wordt herhaald". Drie woorden of meer,
 * want in het Nederlands staat "om de" makkelijk twee keer in een zin zonder dat er iets mis
 * is.
 *
 * ## Meerdere runs, want één schone run bewijst niets
 *
 * Bij Cartesia was de wegval intermitterend: in de handmatige transcriptie van `rauw.wav`
 * ontbrak de disclaimer, in drie latere armen stond hij er volledig in. Wie op één run
 * concludeert, meet ruis. Standaard drie runs, in te stellen met RUNS.
 *
 * ## Wat de TTFT hier wel en niet is
 *
 * Gemeten vanaf deze machine over het publieke internet, niet vanaf Railway. De absolute
 * getallen zijn dus niet de productiegetallen. Wat wél iets zegt is het verschil tussen de
 * twee leveranciers, want die worden in dezelfde run vlak na elkaar gemeten, over dezelfde
 * verbinding. Lees de kolom als een verhouding en niet als een budgettoets.
 *
 * ## Wat deze proef níét kan
 *
 * Klemtoon en intonatie. Een spraakherkenner geeft je woorden terug, geen oordeel over of
 * "ARbeidsrecht" of "arbeidsRECHT" werd gezegd. Daarom schrijft elke arm ook een WAV weg.
 * Dat oordeel is van het oor, en het staat expliciet niet in de tabel.
 *
 * Draaien met: pnpm diag:tts-vergelijk
 */

const CARTESIA_WS = 'wss://api.cartesia.ai/tts/websocket';
const CARTESIA_REST = 'https://api.cartesia.ai/tts/bytes';
const CARTESIA_VERSION = '2025-04-16';
const ELEVEN_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVEN_WS = 'wss://api.elevenlabs.io/v1/text-to-speech';

/** Dezelfde drie zinnen als bij `diag:tts-tekst`, zodat de tabellen naast elkaar passen. */
const ZINNEN = [
  'Goedenavond, Heyo Beentje.',
  'Ik ben de AI-intake-assistent van Van Dijk Arbeidsrecht.',
  'Ik ben geen advocaat en ben aangesteld om de gegevens van uw zaak vast te leggen.',
];
const HEEL = ZINNEN.join(' ');

const RUNS = Number(process.env['RUNS'] ?? 3);

function nodig(naam: string): string {
  const v = process.env[naam];
  if (!v) throw new Error(`${naam} is nodig`);
  return v;
}

const cartesiaKey = nodig('CARTESIA_API_KEY');
const cartesiaVoice = nodig('CARTESIA_VOICE_ID');
const cartesiaModel = process.env['CARTESIA_MODEL'] ?? 'sonic-3';
const elevenKey = nodig('ELEVENLABS_API_KEY');
const elevenVoice = nodig('ELEVENLABS_VOICE_ID');
const elevenModel = process.env['ELEVENLABS_MODEL'] ?? 'eleven_flash_v2_5';

// -------------------------------------------------------------------------- gereedschap

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

/** Bytes naar samples, altijd op een even bytegrens. Zie risico 12 en `diag:audio`. */
function naarPcm(bytes: Buffer): Int16Array {
  const bruikbaar = Math.floor(bytes.length / 2) * 2;
  const kopie = Buffer.from(bytes.subarray(0, bruikbaar));
  return new Int16Array(kopie.buffer, kopie.byteOffset, bruikbaar / 2);
}

function woorden(tekst: string): string[] {
  return tekst
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/u)
    .filter(Boolean);
}

/**
 * Welke woorden uit `bron` ontbreken in `gehoord`?
 *
 * Volgorde-gevoelig, met multiset-semantiek. De herkenner maakt eigen fouten — "AI" wordt
 * "a i" — dus dit is een aanwijzing en geen bewijs. Eén woord verschil is ruis; een
 * aaneengesloten reeks van vijf is dat niet.
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

/** De andere kant op: wat staat er in het transcript dat niet is aangeboden? */
function teveel(bron: string, gehoord: string): string[] {
  return ontbreekt(gehoord, bron);
}

/**
 * De langste aaneengesloten reeks die minstens tweemaal in het transcript staat.
 *
 * Dit is de detector voor de herhaalde staart. Hij kijkt alleen naar het transcript zelf,
 * niet naar de bron — een leverancier die een zin dubbel uitspreekt levert een transcript
 * waarin die zin dubbel staat, ongeacht wat wij hebben aangeboden.
 *
 * Drempel drie woorden: korter komt in normaal Nederlands te vaak voor om iets te betekenen.
 */
function langsteHerhaling(gehoord: string): string[] {
  const w = woorden(gehoord);
  let beste: string[] = [];
  for (let start = 0; start < w.length; start += 1) {
    for (let eind = start + 3; eind <= w.length; eind += 1) {
      const reeks = w.slice(start, eind);
      if (reeks.length <= beste.length) continue;
      const naald = reeks.join(' ');
      const hooiberg = w.join(' ');
      const eerste = hooiberg.indexOf(naald);
      if (eerste !== -1 && hooiberg.indexOf(naald, eerste + naald.length) !== -1) {
        beste = reeks;
      }
    }
  }
  return beste;
}

async function transcribeer(wavBytes: Buffer): Promise<string> {
  const sleutel = nodig('DEEPGRAM_API_KEY');
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

// -------------------------------------------------------------------------- de armen

interface Opbrengst {
  readonly chunks: Buffer[];
  readonly ttftMs: number | null;
  readonly rate: number;
}

/**
 * Een REST-arm die de body streamend leest.
 *
 * Bewust niet `arrayBuffer()`: dan meet je hoe lang de hele synthese duurde en niet wanneer
 * de eerste audio er was. Alleen zo betekent TTFT hier hetzelfde als bij de WebSocket-armen.
 */
async function restStroom(
  url: string,
  init: RequestInit,
  rate: number,
  naam: string,
): Promise<Opbrengst> {
  const t0 = Date.now();
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${naam} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (!res.body) throw new Error(`${naam}: geen body`);
  const chunks: Buffer[] = [];
  let ttftMs: number | null = null;
  for await (const stuk of res.body as unknown as AsyncIterable<Uint8Array>) {
    if (stuk.length === 0) continue;
    if (ttftMs === null) ttftMs = Date.now() - t0;
    chunks.push(Buffer.from(stuk));
  }
  return { chunks, ttftMs, rate };
}

function cartesiaRest(rate: number): Promise<Opbrengst> {
  return restStroom(
    CARTESIA_REST,
    {
      method: 'POST',
      headers: {
        'X-API-Key': cartesiaKey,
        'Cartesia-Version': CARTESIA_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model_id: cartesiaModel,
        transcript: HEEL,
        voice: { mode: 'id', id: cartesiaVoice },
        language: 'nl',
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: rate },
      }),
    },
    rate,
    'Cartesia REST',
  );
}

function elevenRest(rate: number): Promise<Opbrengst> {
  return restStroom(
    `${ELEVEN_BASE}/${elevenVoice}/stream?output_format=pcm_${rate}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: HEEL, model_id: elevenModel, language_code: 'nl' }),
    },
    rate,
    'ElevenLabs REST',
  );
}

/**
 * Cartesia over de WebSocket.
 *
 * `perZin` is de productievorm: `say()` per zin met `continue: true`, daarna `flush()` met
 * `continue: false` en de volledige specificatie — een kaal `{context_id, continue:false}`
 * wordt afgewezen met "invalid voice specification".
 */
async function cartesiaWs(perZin: boolean, rate: number): Promise<Opbrengst> {
  const contextId = `vgl-${perZin ? 'perzin' : 'heel'}-${process.pid}-${nummer()}`;
  const spec = {
    model_id: cartesiaModel,
    voice: { id: cartesiaVoice },
    language: 'nl',
    output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: rate },
    context_id: contextId,
  };
  const berichten = perZin
    ? [
        ...ZINNEN.map((z) => ({ ...spec, transcript: z, continue: true })),
        { ...spec, transcript: '', continue: false },
      ]
    : [{ ...spec, transcript: HEEL, continue: false }];

  const socket = new WebSocket(
    `${CARTESIA_WS}?api_key=${encodeURIComponent(cartesiaKey)}&cartesia_version=${CARTESIA_VERSION}`,
  );
  await new Promise<void>((klaar, mis) => {
    socket.on('open', () => klaar());
    socket.on('error', mis);
  });

  const chunks: Buffer[] = [];
  let ttftMs: number | null = null;
  let t0 = 0;
  const klaar = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Cartesia WS: geen "done" binnen 60 s')), 60_000);
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as { type?: string; data?: string; error?: string };
      if (m.type === 'chunk' && m.data) {
        if (ttftMs === null) ttftMs = Date.now() - t0;
        chunks.push(Buffer.from(m.data, 'base64'));
      } else if (m.type === 'done') {
        clearTimeout(t);
        resolve();
      } else if (m.type === 'error') {
        clearTimeout(t);
        reject(new Error(`Cartesia WS: ${m.error ?? 'onbekend'}`));
      }
    });
  });

  t0 = Date.now();
  for (const b of berichten) socket.send(JSON.stringify(b));
  await klaar;
  socket.close();
  return { chunks, ttftMs, rate };
}

/**
 * ElevenLabs over de WebSocket.
 *
 * Hun protocol wijkt af van dat van Cartesia. Er gaat eerst een openingsbericht met een
 * enkele spatie doorheen; daarna de tekst; daarna een leeg bericht dat de beurt sluit.
 * `auto_mode=true` zet hun eigen bufferschema uit, zodat elk bericht meteen wordt
 * gegenereerd — dat is wat je wilt als je zelf al per zin flusht.
 */
async function elevenWs(perZin: boolean, rate: number): Promise<Opbrengst> {
  const url =
    `${ELEVEN_WS}/${elevenVoice}/stream-input` +
    `?model_id=${elevenModel}&output_format=pcm_${rate}&language_code=nl&auto_mode=true`;
  const socket = new WebSocket(url, { headers: { 'xi-api-key': elevenKey } });
  await new Promise<void>((klaar, mis) => {
    socket.on('open', () => klaar());
    socket.on('error', mis);
  });

  const chunks: Buffer[] = [];
  let ttftMs: number | null = null;
  let t0 = 0;
  const klaar = new Promise<void>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error('ElevenLabs WS: geen afsluiting binnen 60 s')),
      60_000,
    );
    socket.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as {
        audio?: string | null;
        isFinal?: boolean;
        error?: string;
        message?: string;
      };
      if (m.error || (m.message && !m.audio)) {
        clearTimeout(t);
        reject(new Error(`ElevenLabs WS: ${m.error ?? m.message}`));
        return;
      }
      if (m.audio) {
        if (ttftMs === null) ttftMs = Date.now() - t0;
        chunks.push(Buffer.from(m.audio, 'base64'));
      }
      if (m.isFinal) {
        clearTimeout(t);
        resolve();
      }
    });
    socket.on('close', () => {
      clearTimeout(t);
      resolve();
    });
  });

  t0 = Date.now();
  socket.send(JSON.stringify({ text: ' ' }));
  if (perZin) for (const z of ZINNEN) socket.send(JSON.stringify({ text: `${z} ` }));
  else socket.send(JSON.stringify({ text: `${HEEL} ` }));
  socket.send(JSON.stringify({ text: '' }));
  await klaar;
  socket.close();
  return { chunks, ttftMs, rate };
}

let teller = 0;
function nummer(): number {
  teller += 1;
  return teller;
}

// -------------------------------------------------------------------------- uitvoering

interface Meting {
  readonly arm: string;
  readonly run: number;
  readonly chunks: number;
  readonly oneven: number;
  readonly rate: number;
  readonly duurMs: number;
  readonly ttftMs: number | null;
  readonly gehoord: string;
  readonly kwijt: string[];
  readonly extra: string[];
  readonly herhaling: string[];
}

interface Arm {
  readonly naam: string;
  readonly rate: number;
  readonly draai: () => Promise<Opbrengst>;
}

const ARMEN: Arm[] = [
  { naam: 'cartesia · REST', rate: 16_000, draai: () => cartesiaRest(16_000) },
  { naam: 'cartesia · WS heel', rate: 16_000, draai: () => cartesiaWs(false, 16_000) },
  { naam: 'cartesia · WS per zin', rate: 16_000, draai: () => cartesiaWs(true, 16_000) },
  { naam: 'elevenlabs · REST', rate: 24_000, draai: () => elevenRest(24_000) },
  { naam: 'elevenlabs · WS heel', rate: 24_000, draai: () => elevenWs(false, 24_000) },
  { naam: 'elevenlabs · WS per zin', rate: 24_000, draai: () => elevenWs(true, 24_000) },
];

const map = join(process.cwd(), 'measurements', 'tts-vergelijk');

async function meet(arm: Arm, run: number): Promise<Meting> {
  const op = await arm.draai();
  const pcm = naarPcm(Buffer.concat(op.chunks));
  const wavBytes = wav(pcm, op.rate);

  // Alleen de eerste run wegschrijven: drie keer dezelfde zin per arm helpt het oor niet.
  if (run === 1) {
    writeFileSync(join(map, `${arm.naam.replace(/[^a-z0-9]+/gi, '-')}.wav`), wavBytes);
  }

  const gehoord = await transcribeer(wavBytes);
  return {
    arm: arm.naam,
    run,
    chunks: op.chunks.length,
    oneven: op.chunks.filter((c) => c.length % 2 !== 0).length,
    rate: op.rate,
    duurMs: Math.round((pcm.length / op.rate) * 1000),
    ttftMs: op.ttftMs,
    gehoord,
    kwijt: ontbreekt(HEEL, gehoord),
    extra: teveel(HEEL, gehoord),
    herhaling: langsteHerhaling(gehoord),
  };
}

/**
 * Honoreert de leverancier `sample_rate` over de WebSocket?
 *
 * ## Waarom de voor de hand liggende toets niet deugt
 *
 * De eerste opzet vroeg dezelfde tekst op 16000 en op 24000 en keek of het aantal samples
 * anderhalf keer zo groot werd. Dat is dezelfde fout als de duurvergelijking uit risico 17:
 * het zijn twee losse generaties, en dezelfde tekst levert bij deze leveranciers tot 18
 * procent duurverschil. De verhouding kwam er dan ook uit op 1,36 en 1,43 in plaats van
 * 1,50 — getallen waar je met een drempel elke gewenste conclusie uit haalt.
 *
 * ## De toets die ook niet werkte
 *
 * Daarna: één generatie, twee etiketten — dezelfde bytes als WAV weggeschreven met 24000 en
 * met 16000 in de kop, en de herkenner mag zeggen welke de waarheid is. Uitkomst: 6 tegen 5
 * woorden kwijt bij Cartesia, 3 tegen 1 bij ElevenLabs. Deepgram verstaat spraak die
 * anderhalf keer te snel loopt kennelijk gewoon. De toets discrimineert niet en zei dat
 * zelf: ONBESLIST.
 *
 * ## De toets die wel werkt
 *
 * Het spreektempo dat uit de opgegeven rate vólgt. Dat is duurvariatie-bestendig, want het
 * wordt genormaliseerd op de inhoud: dezelfde 29 woorden, hoe lang de generatie ook uitvalt.
 *
 * Klopt de opgegeven rate, dan komt er een tempo uit dat een mens ook aanhoudt — Nederlands
 * loopt tussen ruwweg 2 en 4,5 woorden per seconde. Wordt de parameter genegeerd en zijn de
 * samples in werkelijkheid 16 kHz, dan is de berekende duur twee derde van de echte en
 * schiet het tempo met een factor anderhalf omhoog, naar boven de 5 woorden per seconde. Dat
 * tempo bestaat niet in gesproken Nederlands, dus het onderscheid is hard.
 *
 * De REST-arm van dezelfde leverancier staat ernaast als ijkpunt. Die honoreert de parameter
 * aantoonbaar — 56470 bytes op 16000 tegen 84706 op 24000 voor dezelfde zin, een verhouding
 * van 1,4998. Wijkt het WS-tempo daar sterk vanaf terwijl de tekst gelijk is, dan zit het
 * verschil in de rate en niet in de stem.
 */
async function toetsSampleRate(): Promise<void> {
  console.log('\n  Honoreert de WebSocket de gevraagde sample rate?');
  console.log('  (spreektempo dat uit de opgegeven rate volgt; Nederlands loopt 2–4,5 w/s)\n');

  const aantalWoorden = woorden(HEEL).length;
  const proeven: [string, () => Promise<Opbrengst>, () => Promise<Opbrengst>][] = [
    ['cartesia', () => cartesiaWs(false, 24_000), () => cartesiaRest(24_000)],
    ['elevenlabs', () => elevenWs(false, 24_000), () => elevenRest(24_000)],
  ];

  for (const [naam, ws, rest] of proeven) {
    try {
      const tempo = async (draai: () => Promise<Opbrengst>): Promise<number> => {
        const op = await draai();
        const seconden = naarPcm(Buffer.concat(op.chunks)).length / op.rate;
        return seconden === 0 ? 0 : aantalWoorden / seconden;
      };
      const wsTempo = await tempo(ws);
      const restTempo = await tempo(rest);

      const oordeel =
        wsTempo > 5
          ? 'GENEGEERD — dit tempo bestaat niet; de samples zijn in werkelijkheid trager'
          : wsTempo >= 2 && wsTempo <= 4.5
            ? 'gehonoreerd — 24 kHz levert een menselijk spreektempo'
            : 'ONBESLIST — tempo buiten het bereik waarop deze toets uitspraak doet';

      console.log(
        `    ${naam.padEnd(11)} WS ${wsTempo.toFixed(2)} w/s · REST ${restTempo.toFixed(2)} w/s` +
          ` (ijkpunt) · ${oordeel}`,
      );
    } catch (e) {
      console.log(`    ${naam.padEnd(11)} proef mislukt: ${String(e).slice(0, 120)}`);
    }
  }

  /*
   * De tweede toets, onafhankelijk van de eerste.
   *
   * Deze uitkomst spreekt de toelichting bij `CartesiaTtsStream.connect()` tegen, en die
   * toelichting draagt een `throw` die 24 kHz vandaag onmogelijk maakt. Eén meting die een
   * eerdere meting omkeert, is niet genoeg — zie risico 16. Dus meet dit het van de andere
   * kant: het aantal samples voor dezelfde tekst op 16000 tegen 24000, over meerdere runs.
   *
   * Wordt de parameter gehonoreerd, dan gaat die verhouding naar 1,5. Wordt hij genegeerd,
   * dan blijft hij op 1,0. Duurvariatie is ±18 procent, dus alleen dat onderscheid is te
   * maken — een verhouding van 1,36 hoort bij 1,5 en niet bij 1,0, maar zegt niets over de
   * precieze waarde.
   */
  console.log('\n  Tegenproef: samples voor dezelfde tekst op 16 tegen 24 kHz');
  console.log('  (gehonoreerd → naar 1,50; genegeerd → blijft op 1,00; ruis is ±18%)\n');

  const N = Math.max(2, RUNS);
  for (const [naam, ws] of [
    ['cartesia', (r: number) => cartesiaWs(false, r)],
    ['elevenlabs', (r: number) => elevenWs(false, r)],
  ] as [string, (r: number) => Promise<Opbrengst>][]) {
    try {
      const gemiddelde = async (rate: number): Promise<number> => {
        let som = 0;
        for (let i = 0; i < N; i += 1)
          som += naarPcm(Buffer.concat((await ws(rate)).chunks)).length;
        return som / N;
      };
      const s16 = await gemiddelde(16_000);
      const s24 = await gemiddelde(24_000);
      const verhouding = s16 === 0 ? 0 : s24 / s16;
      const oordeel =
        verhouding >= 1.25
          ? 'gehonoreerd'
          : verhouding <= 1.15
            ? 'GENEGEERD'
            : 'ONBESLIST — precies tussen 1,00 en 1,50 in';
      console.log(
        `    ${naam.padEnd(11)} ${Math.round(s16)} vs ${Math.round(s24)} samples` +
          ` (${N} runs elk) · verhouding ${verhouding.toFixed(2)} · ${oordeel}`,
      );
    } catch (e) {
      console.log(`    ${naam.padEnd(11)} tegenproef mislukt: ${String(e).slice(0, 120)}`);
    }
  }
}

function tabel(metingen: Meting[]): void {
  const kop = [
    'arm'.padEnd(23),
    'run'.padStart(3),
    'kHz'.padStart(4),
    'duur'.padStart(7),
    'TTFT'.padStart(6),
    'chunks'.padStart(7),
    'oneven'.padStart(7),
    'kwijt'.padStart(6),
    'extra'.padStart(6),
    'herhaald'.padStart(9),
  ].join(' ');
  console.log(`\n  ${kop}`);
  console.log(`  ${'-'.repeat(kop.length)}`);
  for (const m of metingen) {
    console.log(
      `  ${[
        m.arm.padEnd(23),
        String(m.run).padStart(3),
        String(m.rate / 1000).padStart(4),
        `${m.duurMs} ms`.padStart(7),
        (m.ttftMs === null ? '—' : `${m.ttftMs} ms`).padStart(6),
        String(m.chunks).padStart(7),
        String(m.oneven).padStart(7),
        String(m.kwijt.length).padStart(6),
        String(m.extra.length).padStart(6),
        String(m.herhaling.length || '').padStart(9),
      ].join(' ')}`,
    );
  }
}

/**
 * Wat gebeurt er in beurt 2, als de context van beurt 1 al gesloten is?
 *
 * ## Waarom deze vraag er is
 *
 * `CartesiaTtsStream.nextTurn()` roteert de context en heeft **nul aanroepers** in de hele
 * repo. Dezelfde vorm als `finishTurn` bij de avatar: een methode die precies het goede doet
 * en die niemand aanroept. `turn-loop.ts` roept aan het eind van een schone beurt wél
 * `avatar.endTurn()` aan (regel 366) maar niets op de TTS; `tts.cancel()` — de enige andere
 * weg naar `newContext()` — loopt alleen bij een barge-in.
 *
 * Gevolg: in een gesprek zonder onderbrekingen krijgt beurt 2 dezelfde `context_id` als
 * beurt 1, en die is met `continue: false` afgesloten.
 *
 * ## Wat deze proef meet
 *
 * Drie beurten over één socket, met dezelfde tekst:
 *
 *   beurt 1  verse context — het ijkpunt
 *   beurt 2  dezelfde context, dus zoals productie het vandaag doet
 *   beurt 3  verse context, zoals het zou gaan als `nextTurn()` werd aangeroepen
 *
 * Levert beurt 2 minder audio dan 1 en 3, dan doet het hergebruik er toe. Levert hij
 * hetzelfde, dan is het dode code en verder niets — ook dat is een antwoord.
 */
async function toetsContextHergebruik(): Promise<void> {
  console.log('\n  Beurt 2 op een gesloten context — doet het hergebruik er toe?');
  console.log('  (productie roteert de context niet; nextTurn() heeft nul aanroepers)\n');

  const socket = new WebSocket(
    `${CARTESIA_WS}?api_key=${encodeURIComponent(cartesiaKey)}&cartesia_version=${CARTESIA_VERSION}`,
  );
  await new Promise<void>((klaar, mis) => {
    socket.on('open', () => klaar());
    socket.on('error', mis);
  });

  const beurt = (contextId: string, label: string): Promise<Buffer[]> =>
    new Promise<Buffer[]>((resolve, reject) => {
      const chunks: Buffer[] = [];
      // Ruim, want een gesloten context kan ook gewoon nooit antwoorden. Dat is dan het
      // resultaat: nul bytes en een reden, niet een proef die blijft hangen.
      const t = setTimeout(() => {
        socket.off('message', luister);
        resolve(chunks);
      }, 30_000);
      const luister = (raw: Buffer | string): void => {
        const m = JSON.parse(String(raw)) as { type?: string; data?: string; error?: string };
        if (m.type === 'chunk' && m.data) chunks.push(Buffer.from(m.data, 'base64'));
        else if (m.type === 'done') {
          clearTimeout(t);
          socket.off('message', luister);
          resolve(chunks);
        } else if (m.type === 'error') {
          clearTimeout(t);
          socket.off('message', luister);
          reject(new Error(`${label}: ${m.error ?? 'onbekend'}`));
        }
      };
      socket.on('message', luister);

      const spec = {
        model_id: cartesiaModel,
        voice: { id: cartesiaVoice },
        language: 'nl',
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16_000 },
        context_id: contextId,
      };
      for (const z of ZINNEN)
        socket.send(JSON.stringify({ ...spec, transcript: z, continue: true }));
      socket.send(JSON.stringify({ ...spec, transcript: '', continue: false }));
    });

  const eerste = `hergebruik-${process.pid}-${nummer()}`;
  const derde = `hergebruik-${process.pid}-${nummer()}`;
  const beurten: [string, string][] = [
    ['beurt 1 · verse context', eerste],
    ['beurt 2 · dezelfde context (productie)', eerste],
    ['beurt 3 · verse context (met nextTurn)', derde],
  ];

  for (const [label, ctx] of beurten) {
    try {
      const chunks = await beurt(ctx, label);
      const pcm = naarPcm(Buffer.concat(chunks));
      const ms = Math.round((pcm.length / 16_000) * 1000);
      const gehoord = pcm.length === 0 ? '(niets)' : await transcribeer(wav(pcm, 16_000));
      const kwijt = pcm.length === 0 ? woorden(HEEL).length : ontbreekt(HEEL, gehoord).length;
      console.log(`    ${label.padEnd(38)} ${String(ms).padStart(6)} ms · ${kwijt} woorden kwijt`);
      console.log(`      ${gehoord.slice(0, 150)}`);
    } catch (e) {
      console.log(`    ${label.padEnd(38)} MISLUKT: ${String(e).slice(0, 120)}`);
    }
  }

  socket.close();
}

async function main(): Promise<void> {
  mkdirSync(map, { recursive: true });
  console.log('\n  Cartesia naast ElevenLabs — dezelfde tekst, dezelfde rondgang\n');
  console.log(`  tekst:   ${HEEL}`);
  console.log(`  runs:    ${RUNS} per arm`);
  console.log(`  modellen: cartesia ${cartesiaModel} · elevenlabs ${elevenModel}\n`);
  console.log('  De TTFT is gemeten vanaf deze machine, niet vanaf Railway. Absolute waarden');
  console.log('  zijn dus geen productiegetallen; alleen het verschil tussen de leveranciers');
  console.log('  zegt iets, want die zijn in dezelfde run over dezelfde verbinding gemeten.\n');

  const metingen: Meting[] = [];
  const mislukt: string[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    for (const arm of ARMEN) {
      process.stdout.write(`  run ${run} · ${arm.naam} … `);
      try {
        const m = await meet(arm, run);
        metingen.push(m);
        console.log(`${m.duurMs} ms, ${m.kwijt.length} kwijt, ${m.extra.length} extra`);
      } catch (e) {
        mislukt.push(`run ${run} · ${arm.naam}: ${String(e).slice(0, 160)}`);
        console.log('MISLUKT');
      }
    }
  }

  /*
   * Een proef die niets heeft gemeten, hoort dat als eerste te zeggen. Een tabel met nul
   * rijen en een nette samenvatting eronder is de vorm waarin een mislukte meting eruitziet
   * als een resultaat.
   */
  if (metingen.length === 0) {
    console.log('\n  GEEN ENKELE METING GELUKT. Er valt hieronder niets te concluderen.\n');
    for (const m of mislukt) console.log(`    ${m}`);
    console.log('');
    process.exitCode = 1;
    return;
  }

  tabel(metingen);

  if (mislukt.length > 0) {
    console.log(`\n  ${mislukt.length} arm(en) mislukt — die staan niet in de tabel:`);
    for (const m of mislukt) console.log(`    ${m}`);
  }

  console.log('\n  Wat de herkenner terugkreeg\n');
  for (const m of metingen) {
    console.log(`  ${m.arm} · run ${m.run}`);
    console.log(`    ${m.gehoord || '(niets)'}`);
    if (m.kwijt.length > 0) console.log(`    KWIJT (${m.kwijt.length}): ${m.kwijt.join(' ')}`);
    if (m.extra.length > 0) console.log(`    EXTRA (${m.extra.length}): ${m.extra.join(' ')}`);
    if (m.herhaling.length > 0) {
      console.log(`    HERHAALD (${m.herhaling.length} woorden): ${m.herhaling.join(' ')}`);
    }
    console.log('');
  }

  await toetsSampleRate();
  await toetsContextHergebruik();

  console.log(`\n  WAV's van run 1 staan in ${map}`);
  console.log('  Die zijn voor het oor: klemtoon en intonatie meet deze proef niet.\n');
}

main().catch((e: unknown) => {
  console.error('\n  vergelijking mislukt:', e);
  process.exitCode = 1;
});
