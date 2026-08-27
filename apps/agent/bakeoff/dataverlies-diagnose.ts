import { CartesiaTtsProvider } from '@intake/provider-tts';
import { DeepgramSttProvider, keytermsFor } from '@intake/provider-stt';

import { paceAudio } from '../src/test-support/pace-audio';

/**
 * Verdwijnt er spraak tussen de herkenner en de lus?
 *
 * ## Waarom dit de eerste vraag is
 *
 * Feiten extraheren uit een transcript met gaten levert een dossier op dat er compleet uitziet
 * en het niet is. Alles wat daarna komt — onderwerp, urgentie, volledigheid — rust op de
 * aanname dat het transcript klopt. Die aanname hoort gemeten te zijn.
 *
 * ## Het pad dat nooit is gerepareerd
 *
 * In `deepgram.ts` stapelt `pending` **uitsluitend** op `is_final`:
 *
 *     if (message.is_final) { ...; this.pending = ...; this.emit('final', text); }
 *     else { this.emit('partial', text); }
 *
 * Een tussentijds resultaat mét woorden dat nooit definitief wordt, gaat dus als `partial` naar
 * buiten — waar alleen de barge-in naar kijkt — en verdwijnt daarna. Sluit de beurt op dat
 * moment via het `UtteranceEnd`-vangnet, dan is er niets om te verwerken en komt er een lege
 * beurt. De cliënt heeft gepraat, wij hebben het verstaan, en er gebeurt niets.
 *
 * Dat onderscheid is zichtbaar gemaakt met `tekensGezien`: nul betekent een kuch, meer dan nul
 * betekent dataverlies. Wat er nog niet was, is een meting of dat gevál zich voordoet.
 *
 * ## Wat deze proef doet
 *
 * Vier soorten spraak, elk op ware snelheid met stilte eromheen, en per run wordt geteld:
 *
 *   final          kwam er een definitief resultaat met tekst?
 *   end_of_turn    is de beurt normaal afgesloten, en met welke tekst?
 *   empty_turn     is de beurt leeg gesloten, en met hoeveel `tekensGezien`?
 *
 * De armen zijn gekozen op wat het pad aannemelijk maakt: kort, zacht, en afgebroken. Zacht
 * omdat een lage energie de VAD wel wekt maar de herkenner minder zekerheid geeft; afgebroken
 * omdat de stroom dan sluit terwijl het laatste segment nog niet definitief is.
 *
 * ## Wat de eerste opzet fout deed
 *
 * Die telde per run één uitkomst. Maar de nasleepstilte sluit zélf een tweede, lege beurt, en
 * dan staat er bij een geslaagde meting zowel "tekst ok" als "leeg" — twee beurten door elkaar.
 * Erger: bij de afgebroken arm sloot er hélemaal geen beurt terwijl er twee partials met
 * woorden waren, en die uitkomst viel in geen enkele teller.
 *
 * Daarom een gebeurtenissenlijst per run, op volgorde, en een oordeel per beurt. Woorden die
 * in een partial voorbijkwamen zonder dat er ooit een beurt sloot, zijn óók verdwenen — langs
 * een ander pad dan de lege beurt, met hetzelfde gevolg.
 *
 * ## Wat een uitkomst betekent
 *
 * `empty_turn` met `tekensGezien > 0` is het bewijs dat het pad bestaat. Nul keer over alle
 * runs is géén bewijs dat het niet bestaat — het zegt alleen dat deze vier vormen het niet
 * uitlokken. Dat staat ook in de uitvoer, want dit is precies het soort proef waarvan een
 * schone tabel als geruststelling wordt gelezen.
 *
 * Draaien met: pnpm diag:dataverlies
 */

const SAMPLE_RATE = 16_000;
const RUNS = Number(process.env['RUNS'] ?? 4);
const AANLOOP_MS = 1_000;
const UITLOOP_MS = 2_500;

function nodig(naam: string): string {
  const v = process.env[naam];
  if (!v) throw new Error(`${naam} is nodig`);
  return v;
}

interface Arm {
  readonly naam: string;
  readonly zin: string;
  /** Vermenigvuldiger op de amplitude; 1 is zoals de synthese hem levert. */
  readonly niveau: number;
  /** Fractie van het fragment die wordt behouden; 1 is compleet. */
  readonly deel: number;
  /** Uitloopstilte; kort betekent dat de stroom sluit vlak na het laatste woord. */
  readonly uitloopMs: number;
}

const ARMEN: Arm[] = [
  {
    naam: 'normaal',
    zin: 'Ik ben vorige week op staande voet ontslagen bij mijn werkgever.',
    niveau: 1,
    deel: 1,
    uitloopMs: UITLOOP_MS,
  },
  { naam: 'kort', zin: 'Vorige week.', niveau: 1, deel: 1, uitloopMs: UITLOOP_MS },
  {
    naam: 'zacht',
    zin: 'Ik ben vorige week op staande voet ontslagen bij mijn werkgever.',
    niveau: 0.12,
    deel: 1,
    uitloopMs: UITLOOP_MS,
  },
  {
    naam: 'afgebroken',
    zin: 'Ik ben vorige week op staande voet ontslagen bij mijn werkgever.',
    niveau: 1,
    // Driekwart van de zin, en de stroom sluit meteen daarna: het laatste segment is dan nog
    // niet definitief op het moment dat er geen audio meer komt.
    deel: 0.75,
    uitloopMs: 150,
  },
];

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

/** Fragment bewerken en stilte eromheen zetten. */
function klaarzetten(pcm: Int16Array, arm: Arm): Int16Array {
  const behouden = pcm.subarray(0, Math.max(1, Math.round(pcm.length * arm.deel)));
  const voor = Math.round((AANLOOP_MS / 1000) * SAMPLE_RATE);
  const na = Math.round((arm.uitloopMs / 1000) * SAMPLE_RATE);
  const heel = new Int16Array(voor + behouden.length + na);
  for (let i = 0; i < behouden.length; i += 1) {
    heel[voor + i] = Math.round(behouden[i]! * arm.niveau);
  }
  return heel;
}

interface Gebeurtenis {
  readonly soort: 'partial' | 'final' | 'end_of_turn' | 'empty_turn';
  readonly tekens: number;
  readonly detail: string;
}

interface Meting {
  readonly arm: string;
  readonly run: number;
  readonly log: Gebeurtenis[];
  /** Beurten die met tekst zijn afgesloten. */
  readonly beurtenMetTekst: number;
  /** Lege beurten waarin de herkenner wél woorden had gezien: pad 2. */
  readonly legeBeurtenMetTekens: number;
  /** Woorden in een partial waarna er nooit een beurt sloot. */
  readonly zwevendeTekens: number;
  readonly eersteTekst: string;
}

async function meet(arm: Arm, pcm: Int16Array, run: number): Promise<Meting> {
  const stt = await new DeepgramSttProvider({
    apiKey: nodig('DEEPGRAM_API_KEY'),
    ...(process.env['DEEPGRAM_MODEL'] ? { model: process.env['DEEPGRAM_MODEL'] } : {}),
  }).connect({ language: 'nl', keyterms: keytermsFor('nl') });

  const log: Gebeurtenis[] = [];

  stt.on('partial', (text: string) => {
    log.push({ soort: 'partial', tekens: text.length, detail: '' });
  });
  stt.on('final', (text: string) => {
    log.push({ soort: 'final', tekens: text.length, detail: '' });
  });
  stt.on('end_of_turn', (text: string, meta: { endedBy?: string }) => {
    log.push({ soort: 'end_of_turn', tekens: text.length, detail: meta?.endedBy ?? '' });
  });
  stt.on('empty_turn', (meta: { tekensGezien?: number; endedBy?: string }) => {
    log.push({ soort: 'empty_turn', tekens: meta?.tekensGezien ?? 0, detail: meta?.endedBy ?? '' });
  });

  await paceAudio(pcm, { sampleRate: SAMPLE_RATE, onFrame: (f) => stt.push(f) });

  /*
   * Stilte blíjven sturen, en dit is het verschil tussen een bevinding en een artefact.
   *
   * De eerste twee opzetten stopten met frames sturen en wachtten daarna met een timer. Dan
   * bevriest de stroomklok van Deepgram — die loopt op ontvangen audio — en gaat `UtteranceEnd`
   * nooit af. "Er sloot geen beurt" was dus een eigenschap van de proef.
   *
   * In productie gebeurt dat niet: de microfoon blijft de hele sessie frames sturen, ook als
   * er niemand praat (de poort stuurt dan nullen). Dus doet deze proef dat ook. Wat er daarna
   * nog verdwijnt, verdwijnt echt.
   */
  const stiltes = new Int16Array(Math.round(3 * SAMPLE_RATE));
  await paceAudio(stiltes, { sampleRate: SAMPLE_RATE, onFrame: (f) => stt.push(f) });
  await new Promise((r) => setTimeout(r, 500));
  await stt.close();

  /*
   * Zwevende tekens: woorden die in een partial voorbijkwamen en waarna er nooit een beurt is
   * gesloten. Die zijn even hard verdwenen als een lege beurt, alleen langs een ander pad.
   */
  let zwevend = 0;
  let hoogstePartial = 0;
  let metTekst = 0;
  let legeMetTekens = 0;
  let eersteTekst = '';
  for (const g of log) {
    if (g.soort === 'partial') hoogstePartial = Math.max(hoogstePartial, g.tekens);
    else if (g.soort === 'end_of_turn') {
      if (g.tekens > 0) metTekst += 1;
      if (!eersteTekst && g.tekens > 0) eersteTekst = String(g.tekens);
      hoogstePartial = 0;
    } else if (g.soort === 'empty_turn') {
      if (g.tekens > 0) legeMetTekens += 1;
      hoogstePartial = 0;
    }
  }
  zwevend = hoogstePartial;

  return {
    arm: arm.naam,
    run,
    log,
    beurtenMetTekst: metTekst,
    legeBeurtenMetTekens: legeMetTekens,
    zwevendeTekens: zwevend,
    eersteTekst,
  };
}

async function main(): Promise<void> {
  console.log('\n  Verdwijnt er spraak tussen de herkenner en de lus?\n');
  console.log('  Een lege beurt met tekensGezien > 0 is dataverlies: de herkenner zag woorden');
  console.log('  en `pending` stapelt alleen op is_final, dus ze zijn nergens heen gegaan.\n');

  const audio = new Map<string, Int16Array>();
  for (const arm of ARMEN) audio.set(arm.naam, klaarzetten(await synthetiseer(arm.zin), arm));

  const metingen: Meting[] = [];
  const mislukt: string[] = [];
  for (let run = 1; run <= RUNS; run += 1) {
    for (const arm of ARMEN) {
      process.stdout.write(`  run ${run} · ${arm.naam} … `);
      try {
        const m = await meet(arm, audio.get(arm.naam)!, run);
        metingen.push(m);
        const verloren = m.legeBeurtenMetTekens > 0 || m.zwevendeTekens > 0;
        console.log(
          verloren
            ? `VERLIES — ${m.legeBeurtenMetTekens} lege beurt(en) met tekens, ` +
                `${m.zwevendeTekens} zwevende tekens`
            : `${m.beurtenMetTekst} beurt(en) met tekst`,
        );
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
    'met tekst'.padStart(10),
    'leeg+tekens'.padStart(12),
    'zwevend'.padStart(8),
    'gebeurtenissen',
  ].join(' ');
  console.log('');
  console.log(`  ${kop}`);
  console.log(`  ${'-'.repeat(kop.length + 30)}`);
  for (const m of metingen) {
    const reeks = m.log
      .map((g) =>
        g.soort === 'partial'
          ? `p${g.tekens}`
          : g.soort === 'final'
            ? `F${g.tekens}`
            : g.soort === 'end_of_turn'
              ? `EIND(${g.tekens})`
              : `LEEG(${g.tekens})`,
      )
      .join(' ');
    console.log(
      `  ${[
        m.arm.padEnd(12),
        String(m.run).padStart(3),
        String(m.beurtenMetTekst).padStart(10),
        String(m.legeBeurtenMetTekens).padStart(12),
        String(m.zwevendeTekens).padStart(8),
        reeks,
      ].join(' ')}`,
    );
  }
  console.log('');
  console.log('  p = partial (tekens), F = final, EIND = beurt met tekst, LEEG = lege beurt');

  if (mislukt.length > 0) {
    console.log('');
    console.log(`  ${mislukt.length} arm(en) mislukt — die staan niet in de tabel:`);
    for (const m of mislukt) console.log(`    ${m}`);
  }

  const legeMetTekens = metingen.filter((m) => m.legeBeurtenMetTekens > 0);
  const zwevend = metingen.filter((m) => m.zwevendeTekens > 0);
  const geenBeurt = metingen.filter((m) => m.beurtenMetTekst === 0);

  console.log('');
  console.log('  Wat hieruit volgt');
  console.log('');
  console.log(`    metingen:                                   ${metingen.length}`);
  console.log(`    lege beurt MET verstane tekens (pad 2):     ${legeMetTekens.length}`);
  console.log(`    partial met woorden, daarna geen beurt:     ${zwevend.length}`);
  console.log(`    runs zonder enige beurt met tekst:          ${geenBeurt.length}`);

  const verlies = new Set([...legeMetTekens, ...zwevend].map((m) => m.arm));
  if (verlies.size > 0) {
    console.log('');
    console.log(`    ER VERDWIJNT SPRAAK. Armen: ${[...verlies].join(', ')}.`);
    console.log('    De herkenner zag woorden en de lus kreeg ze niet. Alles wat op het');
    console.log('    transcript rust — feiten, urgentie, volledigheid — erft dat gat, en een');
    console.log('    dossier met een gat ziet er compleet uit.');
  } else {
    console.log('');
    console.log('    Geen verlies in deze vier vormen. Dat is GEEN bewijs dat het pad niet');
    console.log('    bestaat: `pending` stapelt nog steeds alleen op is_final. Deze vormen');
    console.log('    lokken het alleen niet uit. Zie RISICOS.md risico 2.');
  }
  console.log('');
}

main().catch((e: unknown) => {
  console.error('\n  proef mislukt:', e);
  process.exitCode = 1;
});
