import { AnthropicLlmProvider } from '@intake/provider-llm';
import { CartesiaTtsProvider } from '@intake/provider-tts';
import type { OrgConfig } from '@intake/domain';
import { LATENCY_BUDGET_MS } from '@intake/domain';
import { IntakeSession } from '../src/intake-session';
import { mediaConfigFrom, startEchoSession } from '../src/echo-session';
import type { CompletedTurn } from '../src/turn-loop';

/**
 * T2 — hoeveel gelijktijdige gesprekken houdt één worker binnen het budget?
 *
 * ## De vraag
 *
 * Weg A draait alle sessies in één Node-proces. Dat schaalt horizontaal — een WebSocket is
 * één TCP-verbinding en blijft vanzelf bij één proces — maar hoevéél er in één replica
 * passen voordat de beurtlatency eronder lijdt, is nooit gemeten. Zolang dat getal er niet
 * is, rust de hele keuze voor weg A op een aanname.
 *
 * De poort staat op p50 < 1500 ms (Fase 1); het productiedoel is 1200 ms.
 *
 * ## Waarom met échte leveranciers
 *
 * Met fakes meet je alleen onze eigen overhead, en die is per beurt een handvol
 * bufferbewerkingen. Dat levert een geruststellend getal op dat niets zegt: de
 * gelijktijdigheidsgrenzen zitten bij Deepgram, Cartesia en het model, niet bij ons. Een
 * proef die de duurste onbekende wegneemt in plaats van hem te meten, is precies het
 * patroon dat dit project deze week drie keer heeft gevangen.
 *
 * ## Wat er niet in zit, en dat is geen detail
 *
 * **De avatar.** Er draait geen avatarleverancier; de null-provider levert de afspeelklok
 * zodat truncatie en barge-in zich normaal gedragen, maar er is geen gezicht. De post
 * `avatar first frame` (begroot op 180 ms p50) zit dus **niet** in de gemeten totalen. Bij
 * het toetsen aan de poort hoort die erbij opgeteld te worden. Anders zou deze proef de
 * duurste post wegnemen en zichzelf laten slagen.
 *
 * **De plek.** Dit draait op de machine waarop je het start, niet op Railway in Amsterdam.
 * De netwerkposten naar de leveranciers zijn dus die van hier. Wat wél overdraagbaar is, is
 * de *vorm* van de curve: hoeveel de latency oploopt van N=1 naar N=10 in hetzelfde proces.
 * Dat is de vraag die T2 stelt.
 *
 * ## Hoe de audio erin komt
 *
 * Dezelfde truc als `diag:speechfinal`: de cliëntspraak wordt vooraf met Cartesia
 * gesynthetiseerd en daarna als microfoonaudio ingevoerd. Vooraf, buiten de klok, en één
 * keer voor alle sessies — anders meet je de synthese mee.
 *
 * En op ware snelheid, in blokken van 20 ms. Sneller invoeren breekt de endpointing:
 * `speech_final` hangt aan VAD over de audio, dus Deepgram moet de stilte werkelijk hóren.
 * Een opname die in één klap binnenkomt, sluit de beurt op een ander mechanisme en meet
 * dan iets anders dan een gesprek.
 *
 * Draaien met: pnpm diag:belasting
 */

const SAMPLE_RATE = 16_000;
const BLOK_MS = 20;
const STILTE_NA_ZIN_SEC = 2.0;

/** De niveaus waarop gemeten wordt. Eén replica, N gelijktijdige gesprekken. */
const NIVEAUS = [1, 3, 5, 10];

/**
 * Wat de cliënt zegt. Vier beurten per sessie.
 *
 * Nederlandse arbeidsrechtzinnen met jargon erin, want de keytermlijst hoort mee te doen:
 * een proef op "hallo hoe gaat het" meet een makkelijker geval dan het product heeft.
 */
const BEURTEN = [
  'Ik ben vorige week op staande voet ontslagen bij mijn werkgever.',
  'Ik heb een vaststellingsovereenkomst gekregen maar nog niet getekend.',
  'Ik werk daar nu zeven jaar en ik heb een vast contract.',
  'Mijn werkgever zegt dat er sprake is van een dringende reden.',
];

const ORG: OrgConfig = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Kantoor De Vries',
  slug: 'devries',
} as OrgConfig;

/*
 * De env zelf lezen, niet via `readAgentEnv()`.
 *
 * Die eist SUPABASE_URL en SUPABASE_PUBLISHABLE_KEY omdat de wórker die nodig heeft. Deze
 * proef praat niet met de database — geen sessietoken, geen RPC — en hoort dus ook niet om
 * te vallen als die configuratie ontbreekt. Dat is dezelfde redenering die al boven
 * `MediaConfig` staat, en de eerste run liep er alsnog op vast: in de gedeelde .env heten
 * die twee `NEXT_PUBLIC_*`, want daar zijn ze van de web-app.
 */
const env = {
  DEEPGRAM_API_KEY: process.env['DEEPGRAM_API_KEY'],
  DEEPGRAM_MODEL: process.env['DEEPGRAM_MODEL'] ?? 'nova-3',
  CARTESIA_API_KEY: process.env['CARTESIA_API_KEY'],
  CARTESIA_VOICE_ID: process.env['CARTESIA_VOICE_ID'],
  ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
  LLM_HOT_MODEL: process.env['LLM_HOT_MODEL'],
  LLM_COLD_MODEL: process.env['LLM_COLD_MODEL'],
};

if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY ontbreekt');
const media = mediaConfigFrom(env);

function p(waarden: readonly number[], percentiel: number): number {
  if (waarden.length === 0) return Number.NaN;
  const s = [...waarden].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((percentiel / 100) * s.length));
  return Math.round(s[i]!);
}

const wacht = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Eén zin synthetiseren en er stilte achter plakken, zodat de beurt normaal sluit. */
async function synthetiseer(zin: string): Promise<Int16Array> {
  /*
   * De cliëntstem, en die staat los van wat de assistent gebruikt.
   *
   * Bewust Cartesia en niet `media.tts`: de assistent draait sinds de wissel op ElevenLabs, en
   * een proef waarin beide kanten dezelfde stem hebben meet de spraakherkenner niet eerlijk.
   * Het houdt Cartesia bovendien in gebruik — een tweede optie die nergens meer draait, is
   * geen tweede optie maar dood pad.
   */
  const tts = new CartesiaTtsProvider({ apiKey: process.env['CARTESIA_API_KEY']! });
  const stream = await tts.open({
    voiceId: process.env['CARTESIA_VOICE_ID']!,
    language: 'nl',
    sampleRate: SAMPLE_RATE,
  });

  const delen: Int16Array[] = [];
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`synthese liep vast op: ${zin}`)), 30_000);
    stream.on('audio', (c) => delen.push(c.pcm));
    stream.on('done', () => {
      clearTimeout(t);
      resolve();
    });
    stream.say(zin);
    stream.flush();
  });
  await stream.close();

  const spraak = delen.reduce((n, d) => n + d.length, 0);
  const stilte = Math.round(SAMPLE_RATE * STILTE_NA_ZIN_SEC);
  const uit = new Int16Array(spraak + stilte);
  let o = 0;
  for (const d of delen) {
    uit.set(d, o);
    o += d.length;
  }
  return uit;
}

interface SessieUitkomst {
  beurten: CompletedTurn[];
  fouten: string[];
}

/**
 * Eén volledig gesprek: de echte keten, het echte model, vier beurten.
 *
 * De sessie draait met de engine als antwoordbron en niet met de echo, want het model is
 * de duurste post in het budget en de post die het meest van gelijktijdigheid kan merken.
 */
async function draaiSessie(audio: readonly Int16Array[], index: number): Promise<SessieUitkomst> {
  const llm = new AnthropicLlmProvider({ apiKey: env.ANTHROPIC_API_KEY! });
  const intake = new IntakeSession({
    llm,
    organization: ORG,
    hotModel: env.LLM_HOT_MODEL ?? 'claude-haiku-4-5-20251001',
    coldModel: env.LLM_COLD_MODEL ?? 'claude-haiku-4-5-20251001',
  });

  const beurten: CompletedTurn[] = [];
  const fouten: string[] = [];

  const sessie = await startEchoSession({
    media,
    language: 'nl',
    respond: intake.responseSource(),
    onTurn: (turn) => {
      beurten.push(turn);
      intake.recordTurn(turn.clientUtterance, turn.assistantContent);
    },
    onTurnError: (e) => fouten.push(`beurt: ${String(e).slice(0, 120)}`),
    onSkippedTurn: (r) => fouten.push(`overgeslagen: ${r}`),
  });

  try {
    // De openingsbeurt hoort erbij: hij loopt door dezelfde lus en telt in productie mee.
    await sessie.loop.open();

    for (const pcm of audio) {
      /*
       * Op ware snelheid invoeren.
       *
       * De klok van de meting loopt binnen de lus (`speechEndedAt` komt uit Deepgram's
       * woordtijdstempels), dus deze lus hoeft alleen het tempo te bewaken. Zakt het proces
       * onder gelijktijdigheid weg, dan lopen deze setTimeouts uit — en dat is precies het
       * effect dat we willen zien in plaats van wegregelen.
       */
      const perBlok = Math.round((SAMPLE_RATE * BLOK_MS) / 1000);
      for (let o = 0; o < pcm.length; o += perBlok) {
        sessie.pushAudio(pcm.subarray(o, Math.min(o + perBlok, pcm.length)));
        await wacht(BLOK_MS);
      }

      /*
       * Doorsturen tijdens het wachten, en dat is geen detail van het harnas.
       *
       * De streamklok van Deepgram loopt alleen als er audio binnenkomt. `speechEndedAt`
       * is streamstart plus het laatste woordtijdstempel, dus elke seconde die wij niets
       * sturen, loopt die klok achter op de wandklok — en `speechEndToSttFinalMs` telt dat
       * verschil er ongemerkt bij op. De eerste run mat daardoor 6 tot 8 seconden
       * "endpointing" die volledig door de pauzes van dit harnas waren gemaakt.
       *
       * Een microfoon zwijgt nooit: hij levert stilte. Dat doen wij hier ook.
       */
      const doel = beurten.length + 1;
      const stilteblok = new Int16Array(perBlok);
      const tot = Date.now() + 30_000;
      while (beurten.length < doel && Date.now() < tot) {
        sessie.pushAudio(stilteblok);
        await wacht(BLOK_MS);
      }
      if (beurten.length < doel) fouten.push(`beurt ${doel} kwam niet binnen 30 s rond`);
    }
  } finally {
    await sessie.close();
  }

  return { beurten, fouten };
}

async function main(): Promise<void> {
  console.log('\n  T2 — gelijktijdige gesprekken op één worker\n');
  console.log(
    `  poort: p50 < ${LATENCY_BUDGET_MS.gateFase1} ms · doel ${LATENCY_BUDGET_MS.productionTarget} ms`,
  );
  console.log(
    `  zonder avatar: tel ${LATENCY_BUDGET_MS.avatarFirstFrame.p50} ms op voor "first frame"\n`,
  );

  console.log('  spraak vooraf synthetiseren…');
  const audio: Int16Array[] = [];
  for (const zin of BEURTEN) audio.push(await synthetiseer(zin));
  const secondes = audio.reduce((n, a) => n + a.length, 0) / SAMPLE_RATE;
  console.log(`  ${audio.length} zinnen, ${secondes.toFixed(1)} s audio per sessie\n`);

  const rijen: {
    n: number;
    beurten: number;
    p50: number;
    p95: number;
    endpointing: number;
    llm: number;
    tts: number;
    fouten: number;
  }[] = [];

  for (const n of NIVEAUS) {
    console.log(`  N=${n}: ${n} gelijktijdige sessie(s) starten…`);
    const begin = Date.now();

    /*
     * Gespreid starten, 250 ms uit elkaar.
     *
     * Allemaal op hetzelfde moment beginnen zet elke sessie in dezelfde fase van de beurt,
     * en dan meet je de piek van een kunstmatig gelijkgeschakelde belasting. In productie
     * komen cliënten niet in de pas binnen.
     */
    const sessies = await Promise.all(
      Array.from({ length: n }, async (_, i) => {
        await wacht(i * 250);
        return draaiSessie(audio, i);
      }),
    );

    const alle = sessies.flatMap((s) => s.beurten);
    // De openingsbeurt heeft geen cliëntuitspraak en dus geen endpointing; die hoort niet
    // in een verdeling over beurtlatency.
    const echte = alle.filter((t) => t.clientUtterance.trim().length > 0);
    const totalen = echte
      .map((t) => t.metrics.totalResponseLatencyMs)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const leg = (kies: (t: CompletedTurn) => number | null | undefined) =>
      p(
        echte.map(kies).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
        50,
      );

    rijen.push({
      n,
      beurten: totalen.length,
      p50: p(totalen, 50),
      p95: p(totalen, 95),
      endpointing: leg((t) => t.metrics.speechEndToSttFinalMs),
      llm: leg((t) => t.metrics.sttToLlmFirstTokenMs),
      tts: leg((t) => t.metrics.llmToTtsFirstAudioMs),
      fouten: sessies.reduce((k, s) => k + s.fouten.length, 0),
    });

    for (const s of sessies) for (const f of s.fouten) console.log(`      ! ${f}`);
    console.log(`  N=${n} klaar in ${Math.round((Date.now() - begin) / 1000)} s\n`);
  }

  /*
   * Eerst zeggen of er iets gemeten is, en pas dan cijfers.
   *
   * De eerste run leverde een nette tabel op met `beurten: 0` en `p50: NaN`, en drie
   * postkolommen die er plausibel uitzagen. Dat is de gevaarlijkste vorm van een mislukte
   * proef: hij ziet eruit als een uitkomst. Een lezer die alleen naar de postkolommen kijkt,
   * neemt getallen mee uit een run die niets heeft gemeten.
   *
   * Deze controle staat vóór de tabel en beëindigt het programma met een exitcode. Een
   * proef die nul metingen oplevert, hoort dat als eerste te zeggen en niet als voetnoot.
   */
  const zonderMeting = rijen.filter((r) => r.beurten === 0);
  if (zonderMeting.length > 0) {
    const regels = [
      '',
      '  GEEN BRUIKBARE METING.',
      '',
      `  Op ${zonderMeting.length} van de ${rijen.length} niveaus kwam geen enkele beurt met een`,
      '  ingevulde totale latency binnen. De postkolommen zouden gevuld zijn en niets',
      '  betekenen, dus ze worden niet getoond.',
      '',
      ...zonderMeting.map((r) => `    N=${r.n}: 0 metingen, ${r.fouten} fout(en) gemeld`),
      '',
      '  Repareer het harnas of de keten voordat je hier cijfers uit leest.',
      '',
    ];
    console.error(regels.join('\n'));
    process.exitCode = 1;
    return;
  }

  console.log('  ┌──────┬─────────┬────────┬────────┬──────────────┬────────┬────────┬────────┐');
  console.log('  │    N │ beurten │    p50 │    p95 │ endpointing  │    llm │    tts │ fouten │');
  console.log('  ├──────┼─────────┼────────┼────────┼──────────────┼────────┼────────┼────────┤');
  for (const r of rijen) {
    const cel = (v: number, b: number) => String(v).padStart(b);
    console.log(
      `  │ ${cel(r.n, 4)} │ ${cel(r.beurten, 7)} │ ${cel(r.p50, 6)} │ ${cel(r.p95, 6)} │ ` +
        `${cel(r.endpointing, 12)} │ ${cel(r.llm, 6)} │ ${cel(r.tts, 6)} │ ${cel(r.fouten, 6)} │`,
    );
  }
  console.log('  └──────┴─────────┴────────┴────────┴──────────────┴────────┴────────┴────────┘');

  const basis = rijen[0];
  const zwaarst = rijen[rijen.length - 1];
  if (basis && zwaarst && Number.isFinite(basis.p50) && Number.isFinite(zwaarst.p50)) {
    const groei = Math.round(((zwaarst.p50 - basis.p50) / basis.p50) * 100);
    const metAvatar = zwaarst.p50 + LATENCY_BUDGET_MS.avatarFirstFrame.p50;
    console.log(
      `\n  N=1 → N=${zwaarst.n}: p50 ${basis.p50} → ${zwaarst.p50} ms (${groei >= 0 ? '+' : ''}${groei}%)`,
    );
    console.log(
      `  Met de avatarpost erbij: ${metAvatar} ms tegen een poort van ${LATENCY_BUDGET_MS.gateFase1} ms.`,
    );
    console.log(
      `  ${metAvatar < LATENCY_BUDGET_MS.gateFase1 ? 'BINNEN de poort.' : 'BUITEN de poort.'}\n`,
    );
  }
}

main().catch((e: unknown) => {
  console.error('\n  proef mislukt:', e);
  process.exitCode = 1;
});
