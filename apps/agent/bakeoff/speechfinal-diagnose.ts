import { CartesiaTtsProvider } from '@intake/provider-tts';
import { DeepgramSttProvider, keytermsFor } from '@intake/provider-stt';

/**
 * Waarom komt het laatste woord niet als `speech_final` door?
 *
 * Live sloten drie beurten via het vangnet, met een endpointing van ~1300 ms. Dat is geen
 * trage endpointing maar een ander mechanisme, en de vraag is waarom het normale pad niet
 * aansloeg.
 *
 * De hypothese volgt uit het verschil tussen de twee. `endpointing` — en daarmee
 * `speech_final` — werkt op **VAD over de audio**: Deepgram moet stilte hóren.
 * `UtteranceEnd` werkt op **gaten tussen woordtijdstempels** en heeft geen stilte nodig,
 * alleen de afwezigheid van woorden. Ruis die geen woorden oplevert, houdt de VAD dus
 * bezig terwijl UtteranceEnd gewoon afgaat.
 *
 * Deze proef stuurt dezelfde zin drie keer in, met een andere ruisvloer achter de stilte,
 * en kijkt welk mechanisme de beurt sluit. Zakt `speech_final` weg zodra er ruis is, dan
 * ligt het aan het niveau van de microfoon en niet aan de instellingen.
 *
 * Draaien met: pnpm diag:speechfinal
 */

const SAMPLE_RATE = 16_000;
const ZIN = 'Ik ben vorige week op staande voet ontslagen bij mijn werkgever.';
const STILTE_SEC = 2.5;

interface Uitkomst {
  naam: string;
  eersteEvent: string | null;
  /** Tijd tussen het einde van de spraak en het sluiten van de beurt. */
  msNaSpraak: number | null;
  speechFinalGezien: boolean;
  utteranceEndGezien: boolean;
  tekst: string;
}

async function synthetiseer(): Promise<Int16Array> {
  const tts = new CartesiaTtsProvider({ apiKey: process.env['CARTESIA_API_KEY']! });
  const stream = await tts.open({
    voiceId: process.env['CARTESIA_VOICE_ID']!,
    language: 'nl',
    sampleRate: SAMPLE_RATE,
  });

  const delen: Int16Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('synthese liep vast')), 30_000);
    stream.on('audio', (c) => delen.push(c.pcm));
    stream.on('done', () => {
      clearTimeout(t);
      resolve();
    });
    stream.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    stream.say(ZIN);
    stream.flush();
  });
  await stream.close();

  const pcm = new Int16Array(delen.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of delen) {
    pcm.set(d, o);
    o += d.length;
  }
  return pcm;
}

/**
 * Spraak plus stilte met een gegeven ruisvloer.
 *
 * `amplitude` is in eenheden van int16 (max 32767). 0 is digitale stilte — die bestaat
 * in een echte opname niet. 100 is ongeveer −50 dBFS: een rustige kamer met een open
 * microfoon. 500 is ongeveer −36 dBFS: een laptopventilator of straatgeluid.
 */
function metRuis(spraak: Int16Array, amplitude: number): Int16Array {
  const stilteLengte = Math.round(STILTE_SEC * SAMPLE_RATE);
  const uit = new Int16Array(spraak.length + stilteLengte);
  uit.set(spraak, 0);
  if (amplitude > 0) {
    for (let i = spraak.length; i < uit.length; i += 1) {
      // Deterministische pseudo-ruis: geen Math.random, zodat twee runs vergelijkbaar zijn.
      const x = Math.sin(i * 12.9898) * 43758.5453;
      uit[i] = Math.round((x - Math.floor(x) - 0.5) * 2 * amplitude);
    }
  }
  return uit;
}

async function proef(naam: string, pcm: Int16Array, spraakMs: number): Promise<Uitkomst> {
  const stt = await new DeepgramSttProvider({
    apiKey: process.env['DEEPGRAM_API_KEY']!,
    model: process.env['DEEPGRAM_MODEL'] ?? 'nova-3',
  }).connect({ language: 'nl', keyterms: keytermsFor('nl') });

  const uitkomst: Uitkomst = {
    naam,
    eersteEvent: null,
    msNaSpraak: null,
    speechFinalGezien: false,
    utteranceEndGezien: false,
    tekst: '',
  };

  // Meten vanaf het einde van de SPRAAK, niet vanaf het einde van de verzending.
  //
  // Eerst stond hier een variabele die pas ná de verzendlus werd gezet. Vuurde het event
  // tijdens het insturen van de stilte — precies wat je wilt meten — dan werd er tegen
  // nul afgetrokken en stond er een onzinnig getal van zeven seconden. Het einde van de
  // spraak is bekend: dat is het begin plus de duur van het spraakdeel.
  let spraakEindeAt = 0;
  stt.on('end_of_turn', (text, meta) => {
    if (uitkomst.eersteEvent) return;
    uitkomst.eersteEvent = meta.endedBy;
    uitkomst.msNaSpraak = Math.round(performance.now() - spraakEindeAt);
    uitkomst.tekst = text;
    if (meta.endedBy === 'speech_final') uitkomst.speechFinalGezien = true;
    else uitkomst.utteranceEndGezien = true;
  });

  // Op ware snelheid: endpointing is een tijdmechanisme, dus sneller insturen zou de
  // meting betekenisloos maken.
  const frame = (SAMPLE_RATE / 1000) * 20;
  const start = performance.now();
  spraakEindeAt = start + spraakMs;
  for (let offset = 0, i = 0; offset < pcm.length; offset += frame, i += 1) {
    const wacht = i * 20 - (performance.now() - start);
    if (wacht > 0) await new Promise((r) => setTimeout(r, wacht));
    stt.push(pcm.slice(offset, Math.min(offset + frame, pcm.length)));
  }
  await new Promise((r) => setTimeout(r, 3000));
  await stt.close();
  return uitkomst;
}

const spraak = await synthetiseer();
const spraakMs = (spraak.length / SAMPLE_RATE) * 1000;
console.log(
  `\n  zin: "${ZIN}"\n  spraak ${Math.round((spraak.length / SAMPLE_RATE) * 1000)} ms + ` +
    `${STILTE_SEC * 1000} ms stilte, model ${process.env['DEEPGRAM_MODEL'] ?? 'nova-3'}\n`,
);

const gevallen: { naam: string; amplitude: number }[] = [
  { naam: 'digitale stilte (amplitude 0)', amplitude: 0 },
  { naam: 'rustige kamer (~-50 dBFS)', amplitude: 100 },
  { naam: 'ventilator/straat (~-36 dBFS)', amplitude: 500 },
  { naam: 'rumoerig (~-24 dBFS)', amplitude: 2000 },
];

console.log(`  ${'ruisvloer'.padEnd(32)}${'sloot via'.padEnd(18)}${'na einde spraak'}`);
for (const geval of gevallen) {
  const r = await proef(geval.naam, metRuis(spraak, geval.amplitude), spraakMs);
  console.log(
    `  ${geval.naam.padEnd(32)}${(r.eersteEvent ?? 'GEEN EVENT').padEnd(18)}` +
      `${r.msNaSpraak === null ? '—' : r.msNaSpraak + ' ms'}`,
  );
}

console.log(
  '\n  speech_final werkt op VAD over de audio; UtteranceEnd op gaten tussen\n' +
    '  woordtijdstempels. Zakt speech_final weg zodra er ruis is, dan ligt het aan het\n' +
    '  niveau van de microfoon en niet aan onze instellingen.\n',
);

process.exit(0);
