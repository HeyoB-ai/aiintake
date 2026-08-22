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

  constructor(private readonly o: TurnLoopOptions) {
    this.metrics = new TurnMetricsRecorder(o.now);

    o.stt.on('end_of_turn', (text) => {
      void this.handleTurn(text);
    });

    o.tts.on('audio', (chunk) => {
      this.metrics.ttsFirstAudio();
      this.emittedMs += chunk.durationMs;
      void o.avatar.pushAudio(chunk.pcm, chunk.seq);
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

  /** Optimistisch dempen zodra de VAD iets hoort. Omkeerbaar. */
  duck(): void {
    if (this.state === 'responding') this.o.onDuck?.(true);
  }

  private async handleTurn(utterance: string): Promise<void> {
    this.metrics.speechEnd();
    this.metrics.sttFinal();

    this.state = 'responding';
    this.currentUtterance = utterance;
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

    const { spokenMs } = await this.o.avatar.interrupt();
    await this.completeTurn({ content: this.sentToTts, interruptedAtChar: null, spokenMs });
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
      metrics: this.metrics.snapshot(),
    };

    this.turnIndex += 1;
    this.state = 'idle';
    this.abort = null;
    await this.o.onTurn(turn);
  }
}
