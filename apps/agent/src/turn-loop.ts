import { lijktOnafgerond, truncateToSpoken, type Language } from '@intake/domain';
import type { AvatarSession } from '@intake/provider-avatar';
import type { SttStream } from '@intake/provider-stt';
import { SentenceFlusher, type TtsStream } from '@intake/provider-tts';
import { classifySpeech, type BargeInDrempels, type SpeechEvidence } from './barge-in';
import { TurnMetricsRecorder, type TurnMetrics } from './metrics';

/**
 * De beurtcyclus.
 *
 *   1. STT meldt end_of_turn                     → de klok start
 *   2. responseSource levert tekst, per fragment → eerste token
 *   3. per zin naar TTS                          → eerste audio
 *   4. audio naar de avatar                      → eerste frame
 *
 * En daar doorheen: barge-in, die op elk moment kan afbreken.
 *
 * Wat deze klasse níét doet: praten met een leverancier. Alles komt binnen als
 * interface, zodat de hele lus — inclusief de truncatie, de timing en het
 * herstelgedrag — draait op fakes en op de null-avatarprovider. Dat is wat Fase 1
 * testbaar maakt vóórdat er een avatarcontract is.
 */

export type ResponseSource = (
  input: { utterance: string; interruptedPrefix?: string },
  signal: AbortSignal,
) => AsyncIterable<string>;

export interface CompletedTurn {
  readonly turnIndex: number;
  readonly clientUtterance: string;
  /** Wat de cliënt daadwerkelijk heeft gehoord. Dit gaat naar messages.content. */
  readonly assistantContent: string;
  /** Wat het model wilde zeggen. Alleen voor audit, nooit als geschiedenis. */
  readonly intendedContent: string;
  readonly interruptedAtChar: number | null;
  readonly spokenMs: number | null;
  /**
   * De STT kapte de uitspraak van de cliënt te vroeg af en er kwam nog tekst achteraan.
   *
   * Dit is dataverlies, geen vertraging: zonder deze vlag zou het transcript er compleet
   * uitzien terwijl er een zinsdeel ontbreekt. Zie RISICOS.md risico 2.
   */
  readonly clientUtteranceWasCut: boolean;
  /**
   * Hoe de STT deze beurt afsloot.
   *
   * Staat hier omdat het de endpointing-meting verklaart: een beurt via het vangnet
   * (`utterance_end`) kost minstens `utterance_end_ms` aan stilte voordat hij sluit.
   * Zo'n uitschieter is dus geen aarzelende cliënt maar een ander codepad, en zonder dit
   * veld zijn die twee in de cijfers niet uit elkaar te houden.
   */
  readonly endedBy: 'speech_final' | 'utterance_end';
  /**
   * Aanloopstilte die de TTS deze beurt heeft weggesneden.
   *
   * Staat hier zodat het zichtbaar is en niet alleen werkt. Een snijder die zijn eigen
   * werk verbergt, kun je niet betrappen op te veel pakken — en dat is precies het risico
   * bij een zachte inzet.
   */
  readonly trimmedLeadingMs: number;
  /**
   * Hoe lang de lus deze beurt heeft ingehouden omdat hij onafgerond klonk.
   *
   * Staat hier omdat die stilte in de metrics anders als vertraging verschijnt zonder dat
   * iemand kan zien waar hij vandaan komt. `metrics.speechEnd` krijgt het einde van de
   * spraak, dus het wachten zit gewoon in de latency van deze beurt — en dat hoort ook zo,
   * want de cliënt heeft het gewacht. Maar dan moet wél af te lezen zijn dat het opzet was.
   */
  readonly wachttijdOnafgerondMs: number;
  readonly metrics: TurnMetrics;
}

export interface TurnLoopOptions {
  readonly stt: SttStream;
  readonly tts: TtsStream;
  readonly avatar: AvatarSession;
  readonly respond: ResponseSource;
  readonly language: Language;
  readonly now: () => number;
  /** Afwijkende barge-in-drempels; zonder dit gelden de domeinconstanten. */
  readonly bargeIn?: BargeInDrempels;
  /**
   * Extra stilte voordat de assistent reageert op een beurt die onafgerond klinkt.
   *
   * 0 of weglaten zet het uit, en dat is bewust de stand waarmee je op gehoor kunt
   * vergelijken. Zie `ONAFGEROND_WACHT_MS` in drempels.ts en onafgerond.ts voor waarom dit
   * zwijgen is en geen aanmoediging.
   */
  readonly onafgerondWachtMs?: number;
  /**
   * De lus houdt een beurt in, of laat hem los.
   *
   * Zonder dit is het inhouden van buitenaf niet te onderscheiden van een lus die vastzit —
   * en dat is precies het gedrag dat je bij het afstellen wilt kunnen aflezen: hoe vaak er
   * gewacht is, en hoe vaak dat wachten iets opleverde.
   *
   * Geen tekst in de melding: §14 laat alleen lengtes toe.
   */
  readonly onOnafgerondeWacht?: (gebeurtenis: OnafgerondeWacht) => void;
  readonly onTurn: (turn: CompletedTurn) => void | Promise<void>;
  /** Optimistisch dempen op de client; omkeerbaar, dus niet hetzelfde als interrupt. */
  readonly onDuck?: (ducked: boolean) => void;
  /** Backchannels zijn geen onderbreking maar een bevestiging. */
  readonly onBackchannel?: (text: string) => void;
  /**
   * De STT kapte de cliënt af; de volledige uitspraak komt hier alsnog binnen.
   *
   * `detectedBy` hoort erbij en is geen detail. Er zijn twee onafhankelijke detectoren en
   * ze falen op verschillende manieren: een woordgat meet de stilte tussen segmenten, een
   * UtteranceEnd meet waar Deepgram zélf het laatste woord zag. Weet je alleen dát er
   * afgekapt is, dan kun je bij een verkeerde melding niet zien wélke van de twee je moet
   * bijstellen — en dat is precies wat er live gebeurde.
   */
  readonly onPrematureCut?: (
    fullUtterance: string,
    gapMs: number,
    detectedBy: 'word_gap' | 'utterance_end',
  ) => void;
  /**
   * Er kwam een beurt binnen zonder bruikbare inhoud van de cliënt.
   *
   * De assistent blijft dan gewoon wachten. Zichtbaar, want stilte zonder melding is
   * niet te onderscheiden van een vastgelopen lus.
   */
  /**
   * `meta` draagt het onderscheid dat de tekst ook maakt, maar dan machinaal.
   *
   * De reden is voor een mens in het log; `dataverlies` is voor de laag die beslist of er een
   * regel in het transcript hoort. Een kuch is geen gat in het dossier, een verstane uitspraak
   * die verdwijnt wél — en dat verschil uit een zin terug moeten parsen is hoe het stilletjes
   * fout gaat.
   */
  readonly onSkippedTurn?: (
    reason: string,
    meta?: { readonly dataverlies: boolean; readonly tekensGezien: number },
  ) => void;
  /**
   * Een beurt liep stuk.
   *
   * Bestaat omdat de lus vanuit een event-handler wordt gestart: zonder afvanger wordt
   * een fout hier een unhandled rejection, en die sloopt het hele proces. Eén mislukte
   * beurt hoort de sessie te kosten, niet de worker met alle andere gesprekken erin.
   */
  readonly onTurnError?: (error: unknown) => void;
}

export interface OnafgerondeWacht {
  /**
   * `wacht` — de beurt wordt ingehouden.
   * `vervolg` — er kwam alsnog tekst; het wachten heeft iets opgeleverd.
   * `verlopen` — de tijd is om en de assistent gaat antwoorden op wat er lag.
   */
  readonly fase: 'wacht' | 'vervolg' | 'verlopen';
  /** Aantal tekens dat wordt vastgehouden. Nooit de tekst zelf — §14. */
  readonly tekens: number;
  /** Hoeveel losse beurten er inmiddels zijn samengevoegd. */
  readonly segmenten: number;
  /** Verstreken wachttijd. Bij `wacht` is dat nul. */
  readonly gewachtMs: number;
}

/**
 * Hoe vaak het wachten mag worden verlengd door een vervolg dat zélf onafgerond klinkt.
 *
 * Zonder grens houdt "en… en… en…" de assistent voor altijd stil, en dan is een stotterende
 * cliënt genoeg om het gesprek te laten hangen. Twee verlengingen betekent ten hoogste drie
 * keer de ingestelde wachttijd; daarna antwoordt ze op wat er ligt. Er is geen tweede
 * omgevingsvariabele voor, want dan zijn er twee knoppen voor één gedrag.
 */
const MAX_VERLENGINGEN = 2;

type State = 'idle' | 'responding' | 'interrupting';

export class TurnLoop {
  private state: State = 'idle';
  private turnIndex = 0;
  private abort: AbortController | null = null;
  private readonly metrics: TurnMetricsRecorder;

  /** Tekst die daadwerkelijk aan de TTS is aangeboden — alleen dít kan gehoord zijn. */
  private sentToTts = '';
  /** Audio die de TTS heeft uitgeleverd. Noemer voor de truncatieberekening. */
  private emittedMs = 0;
  private intended = '';
  private currentUtterance = '';
  /** De gehoorde prefix van de vorige beurt; voedt het herstelgedrag. */
  private lastInterruptedPrefix: string | undefined;
  /** Wordt opgelost als de TTS klaar is met deze beurt. */
  private synthesisDone: (() => void) | null = null;
  /** Is de uitspraak van de cliënt te vroeg afgekapt? */
  private utteranceWasCut = false;
  /** Hoe de STT de lopende beurt afsloot. */
  private endedBy: 'speech_final' | 'utterance_end' = 'speech_final';
  /**
   * De interrupt die op dit moment loopt, als die er is.
   *
   * `handleTurn` had geen enkel besef van de toestand van de lus: hij zette `state` op
   * `responding` en wiste `sentToTts`, `emittedMs` en `intended` — precies de velden
   * waarop `interrupt()` ná zijn `await`s de truncatie berekent. Vandaag valt dat niet op,
   * want `tts.cancel()` en `avatar.interrupt()` sturen alleen een bericht en wachten
   * nergens op, dus er kan geen macrotaak tussen vallen. Dat is geen eigenschap van dit
   * bestand maar van twee andere, en de dag dat een van die twee op een bevestiging gaat
   * wachten, verdwijnt hier een uitspraak zonder melding.
   *
   * Vandaar een expliciete wachtrij van één. Niet overslaan: de uitspraak die tijdens een
   * interrupt binnenkomt, is per definitie de uitspraak waarmee de cliënt onderbrak.
   */
  private lopendeInterrupt: Promise<void> | null = null;
  /**
   * De ingehouden beurt, als de lus er een vasthoudt.
   *
   * `null` is de normale toestand. Zit hier iets in, dan heeft de cliënt een zin uitgesproken
   * die grammaticaal niet af was en zwijgt de assistent tot de tijd om is of tot er een
   * vervolg binnenkomt.
   */
  private wacht: {
    segmenten: string[];
    timer: ReturnType<typeof setTimeout>;
    begonnenOp: number;
    speechEndedAt: number | undefined;
    verlengingen: number;
  } | null = null;
  /** Wachttijd van de beurt die nu wordt afgehandeld; gaat mee in `CompletedTurn`. */
  private wachttijdVanDezeBeurt = 0;

  constructor(private readonly o: TurnLoopOptions) {
    this.metrics = new TurnMetricsRecorder(o.now);

    o.stt.on('end_of_turn', (text, meta) => {
      // Een lege beurt hoort niet in de lus.
      //
      // De STT meldt end_of_turn ook na geluid dat geen woorden opleverde: een kuch, een
      // deur, een stuk stilte na ruis. Zonder deze zeef beantwoordt de assistent een
      // uitspraak die niet bestaat, en belandt er een leeg cliëntbericht in de
      // geschiedenis. Dat laatste is het ergste: elke volgende beurt stuurt dat mee, en
      // de API weigert een bericht zonder inhoud. Eén kuch legde zo het hele gesprek stil.
      if (!text.trim()) {
        o.onSkippedTurn?.('geen bruikbare tekst van de STT', {
          dataverlies: false,
          tekensGezien: 0,
        });
        return;
      }
      this.endedBy = meta?.endedBy ?? 'speech_final';

      // Klinkt de zin onafgerond, dan zwijgt de lus eerst. Zie houdVast().
      if (this.houdVast(text, meta?.speechEndedAt)) return;

      this.startBeurt(text, meta?.speechEndedAt, 0);
    });

    /*
     * Een beurt die begon en eindigde zonder één woord.
     *
     * De STT sloeg dit stilzwijgend over. Hier is het geen fout en ook geen beurt — er
     * valt niets te beantwoorden — maar het hoort wél zichtbaar te zijn: een kuch en een
     * onverstane correctie leveren allebei deze melding op, en alleen de tweede is erg.
     * Zonder deze regel zijn ze van buiten identiek aan stilte.
     */
    o.stt.on('empty_turn', (meta) => {
      /*
       * Twee gevallen, en ze horen niet hetzelfde te klinken.
       *
       * `tekensGezien === 0` is een kuch, een deur, een stoel: er was geluid en geen taal.
       * Onvermijdelijk, en verder onschuldig.
       *
       * `tekensGezien > 0` is dataverlies. De herkenner zag woorden en ze zijn verdwenen —
       * `pending` stapelt uitsluitend op `is_final`, dus een tussentijds resultaat dat nooit
       * definitief werd, gaat als partial naar buiten en wordt weggegooid. De cliënt heeft
       * gepraat, wij hebben het verstaan, en er komt geen beurt. Dat is dezelfde klasse als
       * risico 2 en het hoort met zoveel woorden gemeld te worden.
       */
      o.onSkippedTurn?.(
        meta.tekensGezien > 0
          ? `DATAVERLIES: ${meta.tekensGezien} tekens verstaan maar geen enkele final — ` +
              `beurt gesloten door ${meta.endedBy}, ${meta.resultaten} resultaat/resultaten. ` +
              'De uitspraak van de cliënt is niet verwerkt.'
          : `beurt zonder bruikbare tekst (geen taal verstaan) — afgesloten door ` +
              `${meta.endedBy}, ${meta.resultaten} resultaat/resultaten van de herkenner`,
        { dataverlies: meta.tekensGezien > 0, tekensGezien: meta.tekensGezien },
      );
    });

    o.stt.on('turn_continued', (_text, meta) => {
      /*
       * Houden we de beurt al in, dan is dit geen afkapping maar het vervolg waarop we
       * wachten — er is nog geen antwoord de deur uit en er is dus niets afgekapt.
       *
       * Zonder deze uitzondering meldt elke geslaagde wacht zichzelf als dataverlies, en
       * dan vervuilt precies het signaal waarop risico 2 wordt gevolgd. De tekst komt zo
       * meteen als `end_of_turn` binnen en wordt daar samengevoegd.
       */
      if (this.wacht) return;

      // De cliënt was nog aan het woord; onze beurt was gebaseerd op een halve zin.
      this.currentUtterance = meta.fullUtterance;
      this.utteranceWasCut = true;
      this.o.onPrematureCut?.(meta.fullUtterance, meta.gapMs, meta.detectedBy);

      // Antwoorden we al? Dan beantwoorden we een half gehoorde vraag. Afbreken is hier
      // hetzelfde herstel als bij een barge-in — en dat is precies wat het feitelijk is.
      if (this.state === 'responding') void this.interrupt();
    });

    o.tts.on('audio', (chunk) => {
      this.metrics.ttsFirstAudio();
      this.emittedMs += chunk.durationMs;
      void o.avatar.pushAudio(chunk.pcm, chunk.seq);
    });

    o.tts.on('done', () => {
      this.synthesisDone?.();
    });

    o.avatar.on('first_frame', () => {
      this.metrics.avatarFirstFrame();
    });
  }

  /**
   * De cliënt maakt geluid tijdens een lopende beurt.
   *
   * Wordt gevoed door de client-side VAD (duur) en de eerste STT-partial (tekst). De
   * koppeling van STT `start_of_turn` hieraan is providerspecifiek en hoort bij de
   * echte adapter; de beslissing zelf staat in barge-in.ts en is los getest.
   */
  async onClientSpeech(evidence: SpeechEvidence): Promise<void> {
    if (this.state !== 'responding') return;

    const decision = classifySpeech(evidence, this.o.language, this.o.bargeIn);

    if (decision.kind === 'backchannel') {
      // Niet onderbreken. Wel doorgeven: "ja" op het juiste moment is informatie.
      this.o.onBackchannel?.(decision.text);
      return;
    }
    if (decision.kind === 'ignore') {
      // Optimistisch gedempt, blijkt loos alarm: geluid terug.
      this.o.onDuck?.(false);
      return;
    }

    await this.interrupt();
  }

  /**
   * De openingsbeurt: de assistent begint, zonder dat de cliënt iets heeft gezegd.
   *
   * Dit hoort in de lus en niet erbuiten. Zou de aanroeper de opening zelf naar de TTS
   * sturen, dan telt hij niet mee in de metrics, is hij niet te onderbreken, en gedraagt
   * de eerste beurt zich anders dan alle volgende — precies de beurt waarop de cliënt
   * zijn indruk vormt.
   */
  async open(): Promise<void> {
    if (this.state !== 'idle') return;
    try {
      await this.handleTurn('', this.o.now());
    } catch (error) {
      this.state = 'idle';
      this.o.onTurnError?.(error);
    }
  }

  /** Optimistisch dempen zodra de VAD iets hoort. Omkeerbaar. */
  duck(): void {
    if (this.state === 'responding') this.o.onDuck?.(true);
  }

  /**
   * Ruimt een ingehouden beurt op bij het einde van de sessie.
   *
   * Zonder dit vuurt de timer ná het sluiten van de sessie en gaat er een antwoord op weg
   * over een STT, een TTS en een avatar die al dicht zijn. De uitspraak zelf is dan niet
   * meer te redden — de sessie is voorbij — maar hij hoort wél gemeld te worden, want een
   * cliënt die als laatste iets zei en het niet terugziet, is dataverlies.
   */
  sluit(): void {
    if (!this.wacht) return;
    const w = this.wacht;
    this.wacht = null;
    clearTimeout(w.timer);
    const tekst = w.segmenten.join(' ');
    this.o.onSkippedTurn?.(
      `DATAVERLIES: ${tekst.length} tekens stonden ingehouden als onafgeronde zin toen de ` +
        'sessie sloot. De uitspraak van de cliënt is niet verwerkt.',
      { dataverlies: true, tekensGezien: tekst.length },
    );
  }

  /**
   * Houdt een beurt in als hij onafgerond klinkt, of voegt hem bij een lopende wacht.
   *
   * Geeft `true` terug als de beurt is opgevangen en de aanroeper niets meer hoeft te doen.
   *
   * ## Waarom zwijgen en niet aanmoedigen
   *
   * De eerste versie liet de assistent "Gaat u door." zeggen bij een onafgeronde zin. Dat
   * bleek precies de fout: die zin is zélf een onderbreking. In het gemeten geval haalde de
   * cliënt adem, begon de assistent te praten, en maakte de cliënt daardoor zijn zin niet af.
   * Een mens die hoort dat je nog niet klaar bent, zegt niets. Zie onafgerond.ts.
   */
  private houdVast(text: string, speechEndedAt: number | undefined): boolean {
    const wachtMs = this.o.onafgerondWachtMs ?? 0;
    if (wachtMs <= 0) return false;

    if (this.wacht) {
      /*
       * Dit is het vervolg. Samenvoegen en opnieuw beoordelen: is de zin nu wél af, dan is
       * er geen reden meer om te wachten en gaat de assistent meteen antwoorden — het
       * wachten hoort de beurt niet langer te maken dan nodig.
       */
      const w = this.wacht;
      clearTimeout(w.timer);
      w.segmenten.push(text);
      if (speechEndedAt !== undefined) w.speechEndedAt = speechEndedAt;

      const samen = w.segmenten.join(' ');
      const gewachtMs = Math.round(this.o.now() - w.begonnenOp);
      this.o.onOnafgerondeWacht?.({
        fase: 'vervolg',
        tekens: samen.length,
        segmenten: w.segmenten.length,
        gewachtMs,
      });

      if (!lijktOnafgerond(samen) || w.verlengingen >= MAX_VERLENGINGEN) {
        this.wacht = null;
        this.startBeurt(samen, w.speechEndedAt, gewachtMs);
        return true;
      }

      w.verlengingen += 1;
      w.timer = setTimeout(() => this.laatLos(), wachtMs);
      return true;
    }

    /*
     * Alleen inhouden als de lus zelf niets te doen heeft.
     *
     * Praat de assistent nog, dan is deze uitspraak een onderbreking en hoort zij te stoppen,
     * niet te wachten. Wachten zou daar het omgekeerde doen van wat het hier moet doen: haar
     * langer laten doorpraten over de cliënt heen.
     */
    if (this.state !== 'idle') return false;
    if (!lijktOnafgerond(text)) return false;

    this.wacht = {
      segmenten: [text],
      begonnenOp: this.o.now(),
      speechEndedAt,
      verlengingen: 0,
      timer: setTimeout(() => this.laatLos(), wachtMs),
    };
    this.o.onOnafgerondeWacht?.({
      fase: 'wacht',
      tekens: text.length,
      segmenten: 1,
      gewachtMs: 0,
    });
    return true;
  }

  /** De wachttijd is verstreken zonder vervolg: antwoorden op wat er ligt. */
  private laatLos(): void {
    const w = this.wacht;
    if (!w) return;
    this.wacht = null;

    const samen = w.segmenten.join(' ');
    const gewachtMs = Math.round(this.o.now() - w.begonnenOp);
    this.o.onOnafgerondeWacht?.({
      fase: 'verlopen',
      tekens: samen.length,
      segmenten: w.segmenten.length,
      gewachtMs,
    });
    this.startBeurt(samen, w.speechEndedAt, gewachtMs);
  }

  /**
   * Start de beurtafhandeling vanuit een event-handler.
   *
   * De afvanger hoort hier en niet bij elke aanroeper: zonder hem wordt een fout in de lus
   * een unhandled rejection, en die sloopt de hele worker in plaats van deze ene sessie.
   */
  private startBeurt(
    utterance: string,
    speechEndedAt: number | undefined,
    wachttijdMs: number,
  ): void {
    this.wachttijdVanDezeBeurt = wachttijdMs;
    this.handleTurn(utterance, speechEndedAt).catch((error: unknown) => {
      this.state = 'idle';
      this.o.onTurnError?.(error);
    });
  }

  private async handleTurn(utterance: string, speechEndedAt?: number): Promise<void> {
    /*
     * Wachten tot een lopende interrupt zijn beurt heeft afgesloten.
     *
     * Zonder dit begint deze beurt midden in de afhandeling van de vorige, wist hij de
     * velden waarop de truncatie rust, en schrijft `completeTurn` daarna de zojuist
     * binnengekomen uitspraak weg als toebehorend aan de ónderbroken beurt. De uitspraak
     * verdwijnt dan niet, maar hij komt op de verkeerde plek in het transcript te staan —
     * en dat is bij een correctie erger dan verdwijnen.
     */
    if (this.lopendeInterrupt) await this.lopendeInterrupt;

    /*
     * Nog steeds aan het antwoorden? Dan is dit een onderbreking die de drempels van
     * barge-in.ts niet haalde — te kort, of de partials kwamen nooit binnen — maar die
     * wél een volledige uitspraak heeft opgeleverd. Precies hetzelfde geval als
     * `turn_continued` hierboven, dus dezelfde behandeling: eerst de lopende beurt netjes
     * afsluiten op wat er gehoord is, dan pas deze.
     *
     * Doorlopen zonder dit zou de lopende beurt overschrijven: `sentToTts` en `emittedMs`
     * gaan op nul terwijl de TTS nog speelt, en dan denkt het transcript dat de assistent
     * niets heeft gezegd.
     */
    if (this.state === 'responding') await this.interrupt();

    // t0 is het einde van de spraak, niet het binnenkomen van het event. Het verschil
    // tussen die twee ís de endpointing-latency.
    this.metrics.speechEnd(speechEndedAt);
    this.metrics.sttFinal();

    this.state = 'responding';
    this.currentUtterance = utterance;
    this.utteranceWasCut = false;
    this.intended = '';
    this.sentToTts = '';
    this.emittedMs = 0;

    const abort = new AbortController();
    this.abort = abort;

    const flusher = new SentenceFlusher((sentence) => {
      // Alleen wat hier langskomt kan gehoord worden. De rest zit nog in de buffer en
      // telt bij een barge-in dus niet mee — dat is precies de bedoeling.
      this.sentToTts += (this.sentToTts ? ' ' : '') + sentence;
      this.o.tts.say(sentence);
    });

    const prefix = this.lastInterruptedPrefix;
    this.lastInterruptedPrefix = undefined;

    try {
      for await (const chunk of this.o.respond(
        { utterance, ...(prefix ? { interruptedPrefix: prefix } : {}) },
        abort.signal,
      )) {
        if (abort.signal.aborted) break;
        this.metrics.llmFirstToken();
        this.intended += chunk;
        flusher.push(chunk);
      }
      if (!abort.signal.aborted) flusher.end();
    } catch (error) {
      if (!abort.signal.aborted) throw error;
    }

    if (abort.signal.aborted) {
      // De interrupt-afhandeling heeft de beurt al afgesloten.
      return;
    }

    // Wachten tot de synthese klaar is, en niet zodra de tekststream eindigt.
    //
    // Bij een fake komt de audio synchroon terug en valt het verschil weg, maar een
    // echte leverancier levert hem ná de laatste say(), over het netwerk. Wie hier
    // doorloopt, sluit de beurt af vóórdat er audio is — en meet dan geen eerste audio
    // en geen eerste frame. De HUD stond dan vol streepjes terwijl de lus werkte.
    await this.awaitSynthesis(abort.signal);

    if (abort.signal.aborted) return;

    // Een normaal beurteinde is géén interrupt.
    //
    // Hier stond `avatar.interrupt()`, puur om aan een spokenMs te komen. Bij de
    // null-provider viel dat niet op, maar bij een echte provider stuurt interrupt een
    // "gooi je buffer leeg" naar de leverancier — precies op het moment dat de laatste
    // zin nog staat af te spelen. De HUD zou groen blijven en de cliënt zou de laatste
    // seconde van elke beurt missen.
    //
    // Wat hier hoort is het segment afsluiten. Er is niets afgekapt, dus is alles wat de
    // TTS heeft geproduceerd ook gesproken.
    // Geen `?.` meer: `endTurn` is verplicht in het contract, juist omdat de optionele
    // vorm hier een stille no-op werd toen de null-provider hem `finishTurn` noemde.
    this.o.avatar.endTurn();
    await this.completeTurn({
      content: this.sentToTts,
      interruptedAtChar: null,
      spokenMs: this.emittedMs,
    });
  }

  /**
   * Wacht op het `done`-event van de TTS.
   *
   * Met een timeout, want een leverancier die niets meer terugstuurt mag de sessie niet
   * laten hangen: dan is er hoogstens audio gemist, en dat is te overzien vergeleken met
   * een gesprek dat stilvalt.
   */
  private awaitSynthesis(signal: AbortSignal, timeoutMs = 15_000): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.synthesisDone = null;
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };

      const timer = setTimeout(finish, timeoutMs);
      this.synthesisDone = finish;
      signal.addEventListener('abort', finish, { once: true });

      this.o.tts.flush();
    });
  }

  /**
   * De harde interrupt, in de volgorde die ertoe doet.
   *
   * Eerst de generatie annuleren, dan de TTS stil, dan de avatar. Andersom blijft er
   * audio in de pijplijn zitten die alsnog wordt uitgesproken.
   */
  private async interrupt(): Promise<void> {
    if (this.state !== 'responding') return;
    const taak = this.voerInterruptUit();
    this.lopendeInterrupt = taak;
    try {
      await taak;
    } finally {
      // Alleen opruimen als dit nog dezelfde interrupt is; een latere heeft het veld dan
      // al overgenomen.
      if (this.lopendeInterrupt === taak) this.lopendeInterrupt = null;
    }
  }

  private async voerInterruptUit(): Promise<void> {
    this.state = 'interrupting';
    this.metrics.interruptRequested();

    this.abort?.abort();
    await this.o.tts.cancel();
    this.metrics.silenceReached();

    const { spokenMs } = await this.o.avatar.interrupt();

    // Dit is de belangrijkste regel van de lus. `sentToTts` is wat er is aangeboden,
    // `emittedMs` hoeveel audio daarvan is geproduceerd, en `spokenMs` hoeveel daarvan
    // de cliënt heeft gehoord. Alles daarbuiten is nooit hoorbaar geweest en mag dus
    // niet in het transcript belanden — anders denkt het model dat het een vraag heeft
    // gesteld die de cliënt nooit gehoord heeft.
    const { content, interruptedAtChar } = truncateToSpoken(
      this.sentToTts,
      spokenMs,
      this.emittedMs,
    );

    this.lastInterruptedPrefix = content;
    await this.completeTurn({ content, interruptedAtChar, spokenMs });
  }

  private async completeTurn(result: {
    content: string;
    interruptedAtChar: number | null;
    spokenMs: number | null;
  }): Promise<void> {
    const turn: CompletedTurn = {
      turnIndex: this.turnIndex,
      clientUtterance: this.currentUtterance,
      assistantContent: result.content,
      intendedContent: this.intended,
      interruptedAtChar: result.interruptedAtChar,
      /*
       * Hele milliseconden, en hier afgerond en niet bij de insert.
       *
       * `emittedMs` telt `chunk.durationMs` op, en dat is `(samples / rate) * 1000` — een
       * breuk zodra het aantal samples geen veelvoud van de rate/1000 is. Op 16 kHz kwam dat
       * neer op `samples / 16` en viel het altijd rond; op 24 kHz werd het `samples / 24` en
       * dus meestal niet. De wissel van gisteren maakte een fout zichtbaar die er al zat.
       *
       * `spoken_ms` is een `int`-kolom en weigerde dat met "invalid input syntax for type
       * integer: 20702.458333333336". Twee keer de openingsbeurt van een gesprek kwijt.
       *
       * De drie andere wegen naar dezelfde grootheid rondden al wél af — `cancel()` in beide
       * TTS-adapters en `interrupt()` in de null-avatar. Dit was de vierde, en de enige die
       * het niet deed. Zelfde vorm als de samplerate en de tijdzone: één grootheid, meerdere
       * plekken, en de plek die het fout doet is niet te zien vanaf de andere drie.
       *
       * Afronden hier en niet vlak voor de database, want een conversie op die rand verbergt
       * dat de grootheid zelf misschien niet klopt.
       */
      spokenMs: result.spokenMs === null ? null : Math.round(result.spokenMs),
      clientUtteranceWasCut: this.utteranceWasCut,
      endedBy: this.endedBy,
      trimmedLeadingMs: this.o.tts.trimmedLeadingMs?.() ?? 0,
      wachttijdOnafgerondMs: this.wachttijdVanDezeBeurt,
      metrics: this.metrics.snapshot(),
    };

    this.wachttijdVanDezeBeurt = 0;
    this.turnIndex += 1;
    this.state = 'idle';
    this.abort = null;
    await this.o.onTurn(turn);
  }
}
