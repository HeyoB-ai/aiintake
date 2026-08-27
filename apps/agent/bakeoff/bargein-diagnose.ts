import { CartesiaTtsProvider } from '@intake/provider-tts';
import { DeepgramSttProvider, keytermsFor } from '@intake/provider-stt';

import { classifySpeech } from '../src/barge-in';
import { paceAudio } from '../src/test-support/pace-audio';

/**
 * Wat telt er in de praktijk als een onderbreking?
 *
 * ## De aanleiding
 *
 * De assistent onderbreekt vaker dan eerder, en dat begon rond de samplerate-reparatie. De
 * hypothese daarbij was dat `INTERRUPT_MIN_SPEECH_MS` effectief anderhalf keer ruimer stond
 * toen de audio te traag liep. Die hypothese klopt niet — zie de meting hieronder en de
 * toelichting in RISICOS — maar de vraag eronder is de juiste: waar staan die drempels op, en
 * waar zijn ze op gebaseerd?
 *
 * ## Wat `speechMs` werkelijk is
 *
 * In `echo-session.ts` staat dit:
 *
 *     stt.on('start_of_turn', () => { speechStartedAt = now(); });
 *     stt.on('partial', (text) => loop.onClientSpeech({
 *       speechMs: Math.round(now() - speechStartedAt), text,
 *     }));
 *
 * `speechMs` is dus **niet** de duur van de spraak. Het is de wandkloktijd tussen Deepgram's
 * `SpeechStarted` en de aankomst van het eerste interim-resultaat — netwerkretour plus hun
 * interim-cadans. De naam zegt "hoe lang praat de cliënt al", de waarde zegt "hoe lang deed
 * de leverancier erover om iets terug te sturen".
 *
 * Dat verschil is het hele punt van deze proef. Ligt die afstand structureel boven de 180 ms,
 * dan is `INTERRUPT_MIN_SPEECH_MS` geen drempel meer maar een formaliteit: elke partial die
 * binnenkomt onderbreekt, ongeacht hoe kort de cliënt sprak.
 *
 * ## Wat er gemeten wordt
 *
 * Vier armen, elk op ware snelheid ingevoerd — anders is de afstand betekenisloos, want de
 * tijdstempels van de STT hangen aan de ontvangen audio (zie pace-audio.ts):
 *
 *   zin           een gewone onderbrekende zin
 *   eenwoord      één woord; hier hoort `INTERRUPT_MIN_WORDS` te binden, niet de duur
 *   backchannel   "ja" — hoort géén onderbreking te zijn
 *   ruis          spraakachtige energie zonder taal, als proxy voor kuchen of ademen
 *
 * Per arm: kwam er een `start_of_turn`, kwam er een partial, hoe ver lagen die uit elkaar, en
 * wat besluit `classifySpeech` op precies die waarden. Dat laatste is geen nabootsing — het is
 * de productiefunctie met productie-invoer.
 *
 * ## Wat deze proef niet kan
 *
 * De echo-lus. In productie staat de microfoon open terwijl de assistent praat — de poort in
 * `conversation-client.ts` is een ruisdrempel op RMS en geen demping tijdens het spreken — en
 * de enige bescherming is de echo-onderdrukking van de browser. Of de assistent zichzelf
 * hoort, is met een bestand niet te meten; daar is een echte luidspreker en microfoon voor
 * nodig. Deze proef zegt daar dus niets over, en dat staat ook in de uitvoer.
 *
 * ## Waarom er stilte omheen staat
 *
 * De eerste opzet voerde alleen het fragment in en sloot anderhalve seconde later. Uitkomst:
 * de korte armen leverden helemaal géén partial op, ook "Wacht." niet. Dat zou een bevinding
 * kunnen zijn — maar het is waarschijnlijker een artefact: een stroom die begint met spraak en
 * meteen daarna dichtgaat, is niet wat Deepgram in productie ziet. Daar staat de microfoon
 * continu open en komt er stilte vóór en ná.
 *
 * Er gaat daarom een seconde stilte voor en tweeënhalve na. Dat is dezelfde vorm als
 * `diag:speechfinal` gebruikt, en zonder die stilte meet je de opstart van de stroom in plaats
 * van het gedrag van de detector.
 *
 * Draaien met: pnpm diag:bargein
 */

const SAMPLE_RATE = 16_000;
const RUNS = Number(process.env['RUNS'] ?? 3);
/** Stilte vóór en ná het fragment, zodat de stroom eruitziet als een open microfoon. */
const AANLOOP_MS = 1_000;
const UITLOOP_MS = 2_500;

/** Het fragment met stilte eromheen. */
function metStilte(pcm: Int16Array): Int16Array {
  const voor = Math.round((AANLOOP_MS / 1000) * SAMPLE_RATE);
  const na = Math.round((UITLOOP_MS / 1000) * SAMPLE_RATE);
  const heel = new Int16Array(voor + pcm.length + na);
  heel.set(pcm, voor);
  return heel;
}

interface Arm {
  readonly naam: string;
  readonly wat: string;
  /** `null` betekent: geen spraak, maar gegenereerde energie. */
  readonly zin: string | null;
}

const ARMEN: Arm[] = [
  { naam: 'zin', wat: 'een gewone onderbreking', zin: 'Wacht even, dat klopt niet helemaal.' },
  { naam: 'eenwoord', wat: 'één woord', zin: 'Wacht.' },
  { naam: 'backchannel', wat: 'bevestiging, geen onderbreking', zin: 'Ja.' },
  { naam: 'ruis', wat: 'energie zonder taal', zin: null },
];

function nodig(naam: string): string {
  const v = process.env[naam];
  if (!v) throw new Error(`${naam} is nodig`);
  return v;
}

/**
 * Spraakachtige energie zonder taal.
 *
 * Ruwe proxy voor kuchen of ademen: een korte band-beperkte ruisstoot met een aanzet en een
 * uitloop, op spreekniveau. Het gaat er niet om dat dit als een kuch klinkt — het gaat erom
 * dat er energie is die de VAD kan wekken terwijl er geen woorden in zitten. Dat is precies
 * de vraag: wekt zoiets een harde onderbreking?
 */
function ruisstoot(ms: number): Int16Array {
  const n = Math.round((ms / 1000) * SAMPLE_RATE);
  const pcm = new Int16Array(n);
  let vorige = 0;
  for (let i = 0; i < n; i += 1) {
    // Eenvoudige laagdoorlaat over witte ruis: dat legt de energie in het spraakgebied in
    // plaats van als sissen bovenin.
    const wit = Math.random() * 2 - 1;
    vorige = vorige * 0.85 + wit * 0.15;
    const omhullende = Math.min(1, i / (0.02 * SAMPLE_RATE), (n - i) / (0.05 * SAMPLE_RATE));
    pcm[i] = Math.round(vorige * omhullende * 0.35 * 32767);
  }
  return pcm;
}

async function synthetiseer(zin: string): Promise<Int16Array> {
  const tts = new CartesiaTtsProvider({
    apiKey: nodig('CARTESIA_API_KEY'),
    sampleRate: SAMPLE_RATE,
  });
  const stream = await tts.open({
    voiceId: nodig('CARTESIA_VOICE_ID'),
    language: 'nl',
    sampleRate: SAMPLE_RATE,
  });

  const delen: Int16Array[] = [];
  await new Promise<void>((klaar, mis) => {
    const t = setTimeout(() => mis(new Error(`synthese liep vast op: ${zin}`)), 30_000);
    stream.on('audio', (c) => delen.push(c.pcm));
    stream.on('done', () => {
      clearTimeout(t);
      klaar();
    });
    stream.on('error', (e) => {
      clearTimeout(t);
      mis(e);
    });
    stream.say(zin);
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

interface Meting {
  readonly arm: string;
  readonly run: number;
  /** Vanaf het eerste audioframe tot `start_of_turn`. */
  readonly totStartMs: number | null;
  /** Van `start_of_turn` tot de eerste partial. Dit is wat `speechMs` in productie draagt. */
  /** Wandklok van SpeechStarted tot de eerste partial. De oude, verkeerde grootheid. */
  readonly speechMs: number | null;
  /** De spraakduur van de herkenner. Dit is wat de drempels sinds risico 21 zien. */
  readonly spraakMs: number | null;
  readonly eersteTekst: string;
  readonly woorden: number;
  readonly besluit: string;
  readonly reden: string;
}

async function meet(arm: Arm, pcm: Int16Array, run: number): Promise<Meting> {
  const stt = await new DeepgramSttProvider({
    apiKey: nodig('DEEPGRAM_API_KEY'),
    ...(process.env['DEEPGRAM_MODEL'] ? { model: process.env['DEEPGRAM_MODEL'] } : {}),
  }).connect({ language: 'nl', keyterms: keytermsFor('nl') });

  // De klok begint bij het eerste frame ván het fragment, niet bij de aanloopstilte: anders
  // zit die seconde in elke meting en zegt `tot start` niets meer.
  const begin = performance.now() + AANLOOP_MS;
  let startOfTurnAt: number | null = null;
  let eerstePartialAt: number | null = null;
  let eersteTekst = '';
  let spraakMs: number | null = null;

  stt.on('start_of_turn', () => {
    startOfTurnAt ??= performance.now();
  });
  stt.on('partial', (text: string, meta?: { speechMs: number }) => {
    if (eerstePartialAt !== null) return;
    eerstePartialAt = performance.now();
    eersteTekst = text;
    // De spraakduur van de herkenner. Zonder dit veld valt productie terug op de wandklok en
    // meet de drempel weer netwerkretour — dan hoort deze proef dat te laten zien.
    spraakMs = meta?.speechMs ?? null;
  });

  await paceAudio(metStilte(pcm), { sampleRate: SAMPLE_RATE, onFrame: (f) => stt.push(f) });
  // Nog even doorluisteren: het laatste resultaat komt ná het laatste audioframe binnen.
  await new Promise((r) => setTimeout(r, 1_500));
  await stt.close();

  const speechMs =
    startOfTurnAt !== null && eerstePartialAt !== null
      ? Math.round(eerstePartialAt - startOfTurnAt)
      : null;

  /*
   * De productiefunctie, op de gemeten waarden.
   *
   * Geen nabootsing van de regel maar de regel zelf. Verandert `classifySpeech`, dan verandert
   * deze uitkomst mee — en dat is de bedoeling: een proef die zijn eigen kopie van de logica
   * meebrengt, meet die kopie.
   */
  /*
   * De productiefunctie op de waarde die productie óók gebruikt.
   *
   * Sinds de reparatie van risico 21 draagt `partial` de spraakduur van de herkenner; alleen
   * als die ontbreekt valt de lus terug op de wandklok. Deze proef doet hetzelfde, zodat de
   * tabel meet wat er werkelijk gebeurt en niet wat er zou gebeuren.
   */
  const gebruikt = spraakMs ?? speechMs;
  const besluit =
    gebruikt === null
      ? { kind: 'geen partial', reason: 'nooit bij classifySpeech gekomen' }
      : classifySpeech({ speechMs: gebruikt, text: eersteTekst }, 'nl');

  return {
    arm: arm.naam,
    run,
    totStartMs: startOfTurnAt !== null ? Math.round(startOfTurnAt - begin) : null,
    speechMs,
    spraakMs,
    eersteTekst,
    woorden: eersteTekst.trim() ? eersteTekst.trim().split(/\s+/u).length : 0,
    besluit: besluit.kind,
    reden: 'reason' in besluit ? String(besluit.reason) : '',
  };
}

async function main(): Promise<void> {
  console.log('\n  Wat telt er als een onderbreking?\n');
  console.log('  `speechMs` in productie is de afstand van SpeechStarted tot de eerste partial —');
  console.log('  netwerkretour plus interim-cadans, niet de duur van de spraak. Deze proef meet');
  console.log(`  die afstand op echte audio, ${RUNS} runs per arm.\n`);

  // Eén keer synthetiseren, daarna hergebruiken: de armen moeten dezelfde audio krijgen,
  // anders meet je ook de variatie van de synthese mee.
  const audio = new Map<string, Int16Array>();
  for (const arm of ARMEN) {
    audio.set(arm.naam, arm.zin === null ? ruisstoot(500) : await synthetiseer(arm.zin));
  }

  const metingen: Meting[] = [];
  const mislukt: string[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    for (const arm of ARMEN) {
      process.stdout.write(`  run ${run} · ${arm.naam} … `);
      try {
        const m = await meet(arm, audio.get(arm.naam)!, run);
        metingen.push(m);
        console.log(`${m.speechMs === null ? 'geen partial' : `${m.speechMs} ms`} · ${m.besluit}`);
      } catch (e) {
        mislukt.push(`run ${run} · ${arm.naam}: ${String(e).slice(0, 160)}`);
        console.log('MISLUKT');
      }
    }
  }

  if (metingen.length === 0) {
    console.log('\n  GEEN ENKELE METING GELUKT. Er valt hieronder niets te concluderen.\n');
    for (const m of mislukt) console.log(`    ${m}`);
    process.exitCode = 1;
    return;
  }

  const kop = [
    'arm'.padEnd(12),
    'run'.padStart(3),
    'tot start'.padStart(10),
    'wandklok'.padStart(9),
    'spraak'.padStart(7),
    'woorden'.padStart(8),
    'besluit'.padEnd(13),
    'reden',
  ].join(' ');
  console.log(`\n  ${kop}`);
  console.log(`  ${'-'.repeat(kop.length + 8)}`);
  for (const m of metingen) {
    console.log(
      `  ${[
        m.arm.padEnd(12),
        String(m.run).padStart(3),
        (m.totStartMs === null ? '—' : `${m.totStartMs} ms`).padStart(10),
        (m.speechMs === null ? '—' : `${m.speechMs} ms`).padStart(9),
        (m.spraakMs === null ? '—' : `${m.spraakMs} ms`).padStart(7),
        String(m.woorden).padStart(8),
        m.besluit.padEnd(13),
        m.reden,
      ].join(' ')}`,
    );
  }

  if (mislukt.length > 0) {
    console.log(`\n  ${mislukt.length} arm(en) mislukt — die staan niet in de tabel:`);
    for (const m of mislukt) console.log(`    ${m}`);
  }

  console.log('\n  Wat de herkenner als eerste teruggaf\n');
  for (const m of metingen) {
    console.log(`    ${m.arm.padEnd(12)} run ${m.run}: ${m.eersteTekst || '(niets)'}`);
  }

  // ------------------------------------------------------------------ het oordeel
  const metPartial = metingen.filter((m) => m.speechMs !== null);
  const boven180 = metPartial.filter((m) => (m.speechMs ?? 0) >= 180);
  const ruisMetPartial = metingen.filter((m) => m.arm === 'ruis' && m.speechMs !== null);
  const backchannelOnderbreekt = metingen.filter(
    (m) => m.arm === 'backchannel' && m.besluit === 'interrupt',
  );

  console.log('\n  Wat hieruit volgt\n');
  console.log(`    metingen met een partial:            ${metPartial.length}/${metingen.length}`);
  console.log(
    `    daarvan met speechMs >= 180:         ${boven180.length}/${metPartial.length}` +
      `  (INTERRUPT_MIN_SPEECH_MS = 180)`,
  );
  console.log(`    ruis die tot een partial leidde:     ${ruisMetPartial.length}`);
  console.log(`    backchannels die toch onderbraken:   ${backchannelOnderbreekt.length}`);

  if (metPartial.length > 0 && boven180.length === metPartial.length) {
    console.log('\n    ELKE partial lag boven de drempel. `INTERRUPT_MIN_SPEECH_MS` is dan geen');
    console.log('    drempel maar een formaliteit: wat er ook binnenkomt, de duurtak vuurt. De');
    console.log('    enige rem die dan nog werkt is de backchannel-lijst.');
  }
  if (ruisMetPartial.length === 0) {
    console.log('\n    Energie zonder taal leverde geen partial op. Een kuch of ademhaling komt');
    console.log('    dus niet bij classifySpeech — hij duckt de avatar wel, en dat is omkeerbaar.');
  }

  console.log('\n  Wat deze proef NIET meet: de echo-lus. In productie staat de microfoon open');
  console.log('  terwijl de assistent praat, en of zij zichzelf hoort hangt af van de echo-');
  console.log('  onderdrukking van de browser. Dat vraagt een echte luidspreker en microfoon.\n');
}

main().catch((e: unknown) => {
  console.error('\n  proef mislukt:', e);
  process.exitCode = 1;
});
