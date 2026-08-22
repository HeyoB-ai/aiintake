import { truncateToSpoken, type Language } from '@intake/domain';
import type { AvatarSession } from '@intake/provider-avatar';
import type { SttStream } from '@intake/provider-stt';
import { SentenceFlusher, type TtsStream } from '@intake/provider-tts';
import { classifySpeech, type SpeechEvidence } from './barge-in';
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
  readonly metrics: TurnMetrics;
}

export interface TurnLoopOptions {
  readonly stt: SttStream;
  readonly tts: TtsStream;
  readonly avatar: AvatarSession;
  readonly respond: ResponseSource;
  readonly language: Language;
  readonly now: () => number;
  readonly onTurn: (turn: CompletedTurn) => void | Promise<void>;
  /** Optimistisch dempen op de client; omkeerbaar, dus niet hetzelfde als interrupt. */
  readonly onDuck?: (ducked: boolean) => void;
  /** Backchannels zijn geen onderbreking maar een bevestiging. */
  readonly onBackchannel?: (text: string) => void;
  /** De STT kapte de cliënt af; de volledige uitspraak komt hier alsnog binnen. */
  readonly onPrematureCut?: (fullUtterance: string, gapMs: number) => void;
  /**
   * Er kwam een beurt binnen zonder bruikbare inhoud van de cliënt.
   *
   * De assistent blijft dan gewoon wachten. Zichtbaar, want stilte zonder melding is
   * niet te onderscheiden van een vastgelopen lus.
   */
  readonly onSkippedTurn?: (reason: string) => void;
  /**
   * Een beurt liep stuk.
   *
   * Bestaat omdat de lus vanuit een event-handler wordt gestart: zonder afvanger wordt
   * een fout hier een unhandled rejection, en die sloopt het hele proces. Eén mislukte
   * beurt hoort de sessie te kosten, niet de worker met alle andere gesprekken erin.
   */
  readonly onTurnError?: (error: unknown) => void;
}

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
        o.onSkippedTurn?.('geen bruikbare tekst van de STT');
        return;
      }
      this.handleTurn(text, meta?.speechEndedAt).catch((error: unknown) => {
        this.state = 'idle';
        o.onTurnError?.(error);
      });
    });

    o.stt.on('turn_continued', (_text, meta) => {
      // De cliënt was nog aan het woord; onze beurt was gebaseerd op een halve zin.
      this.currentUtterance = meta.fullUtterance;
      this.utteranceWasCut = true;
      this.o.onPrematureCut?.(meta.fullUtterance, meta.gapMs);

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

    const decision = classifySpeech(evidence, this.o.language);

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

  private async handleTurn(utterance: string, speechEndedAt?: number): Promise<void> {
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
    this.o.avatar.endTurn?.();
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
      spokenMs: result.spokenMs,
      clientUtteranceWasCut: this.utteranceWasCut,
      metrics: this.metrics.snapshot(),
    };

    this.turnIndex += 1;
    this.state = 'idle';
    this.abort = null;
    await this.o.onTurn(turn);
  }
}
