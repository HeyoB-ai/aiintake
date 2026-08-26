import WebSocket from 'ws';

import { AanloopSnijder, base64NaarPcm } from './aanloopstilte';
import type { TextToSpeechProvider, TtsEvents, TtsOptions, TtsStream } from './contract';
import { SpreektempoWacht } from './spreektempo';

/**
 * ElevenLabs Flash over de multi-context WebSocket.
 *
 * ## Waarom deze adapter er is
 *
 * Gemeten met `pnpm diag:tts-vergelijk`, negen metingen per leverancier op de openingszin:
 *
 *                                      Cartesia  ElevenLabs
 *   "Goedenavond" volledig weg            7/9       0/9
 *   "geen advocaat" weg of verminkt       1/9       0/9
 *   herhaalde reeks van 3+ woorden        2/9       0/9
 *
 * De tweede regel gaf de doorslag. Cartesia leverde "ik ben advocaat en ben aangesteld om…" —
 * het woord "geen" weg. De disclaimer zegt dan niet minder dan bedoeld maar het
 * tegenovergestelde, in een gesprek waarin de cliënt precies voor die zin heeft getekend.
 * Eerste audio scheelt 8 ms, dus daar zit de afweging niet.
 *
 * Cartesia blijft werkend als tweede optie (`settings.tts`), zodat de vergelijking te
 * herhalen is.
 *
 * ## Waarom multi-stream-input en niet stream-input
 *
 * Hun gewone `stream-input` kent geen contexten. Annuleren betekent daar de socket sluiten en
 * opnieuw opbouwen, en dat kost 100–200 ms — meer dan het hele TTS-budget. `cancel()` is de
 * zwaarste eis in het contract, niet de stemkwaliteit: bij een barge-in moet het binnen 50 ms
 * stil zijn.
 *
 * `multi-stream-input` geeft elke beurt een eigen `context_id`, precies zoals Cartesia. Bij
 * een barge-in sluiten we die context en negeren we alles wat er nog van binnenkomt.
 *
 * ## Waarom de context hier zichzelf roteert
 *
 * `turn-loop.ts` roept aan het eind van een schone beurt `avatar.endTurn()` aan maar niets op
 * de TTS; de enige weg naar een nieuwe context is `cancel()`, en die loopt alleen bij een
 * barge-in. Bij Cartesia is dat gemeten onschuldig — die accepteert een gesloten context en
 * levert gewoon audio (risico 18).
 *
 * Hier kan dat niet: `close_context` sluit de context echt, en een `say()` daarna zou in het
 * niets verdwijnen. Daarom roteert deze adapter zelf, lui: de eerste `say()` ná een `flush()`
 * opent een nieuwe context. Dat maakt de adapter correct zonder de lus te veranderen, en het
 * is een bewuste keuze en geen omweg — een leverancier die zijn eigen levenscyclus bewaakt,
 * gaat niet stuk aan een aanroeper die er geen kent.
 */

const WS_BASE = 'wss://api.elevenlabs.io/v1/text-to-speech';
const REST_BASE = 'https://api.elevenlabs.io/v1/text-to-speech';

export interface ElevenLabsOptions {
  readonly apiKey: string;
  /**
   * `eleven_flash_v2_5` is het snelste model met Nederlands. `eleven_turbo_v2_5` en
   * `eleven_multilingual_v2` kunnen ook, tegen meer latency.
   */
  readonly model?: string;
  readonly sampleRate?: number;
  /**
   * Spreektempo, 0,7 tot 1,2. Buiten dat bereik weigert hun API met `invalid_voice_settings`.
   *
   * Staat hier als parameter en niet als constante omdat het een afweging is die zonder
   * commit te maken hoort te zijn. Gemeten op de openingszin: ElevenLabs loopt op 1,0
   * ongeveer 2,45 woorden per seconde tegen 3,83 bij Cartesia — ruim drie seconde extra per
   * beurt voordat de cliënt aan het woord komt. Op 1,1 komt het op 3,67 w/s en is dat verschil
   * vrijwel weg.
   *
   * Standaard 1.1: het herstelt het tempo dat we hadden. Wie het rustiger wil, zet
   * `ELEVENLABS_SPEED` lager.
   */
  readonly speed?: number;
  /** Aanloopstilte wegsnijden. Standaard aan. Zie aanloopstilte.ts. */
  readonly trimLeadingSilence?: boolean;
}

const MIN_SPEED = 0.7;
const MAX_SPEED = 1.2;

export class ElevenLabsTtsStream implements TtsStream {
  private readonly handlers = new Map<string, Function[]>();
  private socket: WebSocket | null = null;
  private contextId = '';
  /** Is de huidige context met `close_context` afgesloten? Dan opent `say()` een nieuwe. */
  private gesloten = true;
  private seq = 0;
  private emittedMs = 0;
  private cancelled = false;
  private turn = 0;
  private readonly snijder: AanloopSnijder;
  private readonly tempo = new SpreektempoWacht('ElevenLabs');

  constructor(
    private readonly config: Required<ElevenLabsOptions>,
    private readonly voiceOptions: TtsOptions,
  ) {
    this.snijder = new AanloopSnijder(config.sampleRate, config.trimLeadingSilence);
  }

  async connect(): Promise<void> {
    if (this.config.speed < MIN_SPEED || this.config.speed > MAX_SPEED) {
      // Meteen bij het opzetten en niet pas bij de eerste zin: hun API weigert dit met
      // `invalid_voice_settings`, en dat zou midden in een gesprek een stille beurt opleveren.
      throw new Error(
        `ElevenLabs: speed ${this.config.speed} valt buiten ${MIN_SPEED}–${MAX_SPEED}. ` +
          'Hun API weigert het en de beurt zou geluidloos blijven.',
      );
    }

    const url =
      `${WS_BASE}/${encodeURIComponent(this.voiceOptions.voiceId)}/multi-stream-input` +
      `?model_id=${encodeURIComponent(this.config.model)}` +
      `&output_format=pcm_${this.config.sampleRate}` +
      `&language_code=${encodeURIComponent(this.voiceOptions.language)}` +
      // Zet hun eigen bufferschema uit, zodat elk bericht meteen wordt gegenereerd. Dat is
      // wat je wilt als de aanroeper zelf al per zin flusht (zie SentenceFlusher).
      `&auto_mode=true`;

    /*
     * De sleutel in een header en niet in de URL.
     *
     * Cartesia neemt hem als querystring; die belandt in elk toegangslog onderweg. ElevenLabs
     * accepteert `xi-api-key` als header, en dat is de betere plek.
     *
     * Vandaar de import van `ws` in plaats van de ingebouwde WebSocket van Node, die geen
     * headers bij de handshake toelaat. Als querystring geprobeerd: de socket gáát open —
     * `xi-api-key` in de URL wordt geaccepteerd — maar er komt daarna geen audio terug en
     * geen fout. Dat is precies het soort stille mislukking waar dit project geen behoefte
     * aan heeft, dus: header.
     */
    const socket = new WebSocket(url, { headers: { 'xi-api-key': this.config.apiKey } });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError);
        resolve();
      };
      /*
       * De reden erbij, niet alleen "mislukt".
       *
       * Een WebSocket-`error` draagt geen HTTP-status: bij een mislukte handshake krijg je een
       * leeg event. Bij Cartesia was het in de praktijk `402 Model credits limit reached`, en
       * die melding zoeken kostte een omweg. Dus vragen we het bij een fout na langs hun
       * REST-kant, die wél een status en een tekst geeft.
       */
      const onError = () => {
        void this.diagnose().then((reden) =>
          reject(new Error(`ElevenLabs: verbinding mislukt${reden ? ` — ${reden}` : ''}`)),
        );
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('error', () => this.emit('error', new Error('ElevenLabs: socketfout')));
    this.newContext();
  }

  /** Waarom weigerde hij? Vraagt het na langs REST, die wél een status geeft. */
  private async diagnose(): Promise<string | null> {
    try {
      const res = await fetch(
        `${REST_BASE}/${encodeURIComponent(this.voiceOptions.voiceId)}?output_format=pcm_16000`,
        {
          method: 'POST',
          headers: { 'xi-api-key': this.config.apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: '.',
            model_id: this.config.model,
            language_code: this.voiceOptions.language,
          }),
          signal: AbortSignal.timeout(4_000),
        },
      );
      if (res.ok) return 'de WebSocket weigerde maar hun REST-API antwoordt wel';
      return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    } catch {
      return null;
    }
  }

  /** Elke beurt een eigen context, zodat annuleren precies deze beurt raakt. */
  private newContext(): void {
    this.turn += 1;
    this.contextId = `turn-${this.turn}-${Math.random().toString(36).slice(2, 10)}`;
    this.gesloten = false;
    this.emittedMs = 0;
    this.seq = 0;
    this.cancelled = false;
    this.snijder.reset();
    this.tempo.reset();

    if (this.socket?.readyState !== WebSocket.OPEN) return;
    // Het openingsbericht draagt de steminstellingen; latere berichten in dezelfde context
    // hoeven ze niet te herhalen.
    this.socket.send(
      JSON.stringify({
        text: ' ',
        context_id: this.contextId,
        voice_settings: { speed: this.config.speed },
      }),
    );
  }

  private onMessage(raw: string): void {
    let message: {
      audio?: string | null;
      isFinal?: boolean | null;
      contextId?: string;
      error?: string;
      message?: string;
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // Een late chunk van een geannuleerde context negeren we; die is nooit gehoord.
    if (message.contextId && message.contextId !== this.contextId) return;
    if (this.cancelled) return;

    if (message.error ?? (message.message && !message.audio)) {
      this.emit('error', new Error(`ElevenLabs: ${message.error ?? message.message}`));
      return;
    }

    if (message.audio) {
      const { pcm: ruw, oneven } = base64NaarPcm(message.audio);
      if (oneven) {
        // Nooit stil: als dit ooit afgaat, is elke sample hierna een byte verschoven.
        this.emit(
          'error',
          new Error('ElevenLabs: chunk met oneven aantal bytes; de audio hierna kan scheef staan.'),
        );
      }
      const pcm = this.snijder.verwerk(ruw);
      if (pcm.length === 0) return;

      const durationMs = (pcm.length / this.config.sampleRate) * 1000;
      this.emittedMs += durationMs;
      this.emit('audio', { pcm, seq: this.seq++, durationMs });
    }

    if (message.isFinal) {
      const klacht = this.tempo.controleer(this.emittedMs, this.config.sampleRate);
      if (klacht) this.emit('error', new Error(klacht));
      this.emit('done');
    }
  }

  trimmedLeadingMs(): number {
    return this.snijder.weggesnedenMs;
  }

  say(text: string): void {
    if (this.cancelled || !this.socket) return;
    // De vorige beurt is afgesloten; deze zin hoort bij een nieuwe. Zie de toelichting boven
    // deze klasse: de lus roept hier niets voor aan, dus doet de adapter het zelf.
    if (this.gesloten) this.newContext();
    this.tempo.telTekst(text);
    /*
     * De spatie erachter is geen opmaak.
     *
     * Hun tokenizer plakt anders het laatste woord van deze zin aan het eerste woord van de
     * volgende, en dat levert een uitspraak op die klinkt als één samengesteld woord.
     */
    this.socket.send(JSON.stringify({ text: `${text} `, context_id: this.contextId }));
  }

  /** Er komt geen tekst meer bij voor deze beurt; `isFinal` volgt zodra alles klaar is. */
  flush(): void {
    if (this.cancelled || !this.socket) return;
    this.socket.send(JSON.stringify({ context_id: this.contextId, close_context: true }));
    this.gesloten = true;
  }

  async cancel(): Promise<{ spokenMs: number }> {
    const spokenMs = Math.round(this.emittedMs);
    this.cancelled = true;

    if (this.socket?.readyState === WebSocket.OPEN && !this.gesloten) {
      // Server stopt met deze context. De socket blijft open voor de volgende beurt — dat is
      // precies waarom we per beurt een context gebruiken.
      this.socket.send(JSON.stringify({ context_id: this.contextId, close_context: true }));
    }

    this.newContext();
    return { spokenMs };
  }

  /** Voorbereiden op de volgende beurt zonder te annuleren. */
  nextTurn(): void {
    if (!this.gesloten) this.flush();
    this.newContext();
  }

  on<E extends keyof TtsEvents>(event: E, handler: TtsEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Function);
    this.handlers.set(event, list);
  }

  async close(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      // Netjes afsluiten: hun server ruimt de contexten op en stuurt de socket dicht.
      this.socket.send(JSON.stringify({ close_socket: true }));
    }
    this.socket?.close();
    this.socket = null;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const h of this.handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
  }
}

export class ElevenLabsTtsProvider implements TextToSpeechProvider {
  readonly id = 'elevenlabs';
  private readonly config: Required<ElevenLabsOptions>;

  constructor(options: ElevenLabsOptions) {
    this.config = {
      apiKey: options.apiKey,
      model: options.model ?? 'eleven_flash_v2_5',
      sampleRate: options.sampleRate ?? 24_000,
      speed: options.speed ?? 1.1,
      trimLeadingSilence: options.trimLeadingSilence ?? true,
    };
  }

  async open(options: TtsOptions): Promise<TtsStream> {
    const stream = new ElevenLabsTtsStream(
      { ...this.config, ...(options.sampleRate ? { sampleRate: options.sampleRate } : {}) },
      options,
    );
    await stream.connect();
    return stream;
  }
}
