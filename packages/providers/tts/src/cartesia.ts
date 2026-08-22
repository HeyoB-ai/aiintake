import type { TextToSpeechProvider, TtsEvents, TtsOptions, TtsStream } from './contract';

/**
 * Cartesia Sonic over WebSocket.
 *
 * De verbinding blijft de hele sessie open. Per beurt een socket opzetten kost 100–200
 * ms, en dat is meer dan het hele TTS-budget (p50 80 ms).
 *
 * Elke beurt krijgt een eigen `context_id`. Dat is wat annuleren mogelijk maakt: bij een
 * barge-in sturen we een cancel voor precies die context, waarna de server stopt met
 * genereren. Zonder context-id zou je de socket moeten sluiten, en dan betaal je de
 * heropbouw in de volgende beurt.
 */

const WS_URL = 'wss://api.cartesia.ai/tts/websocket';
// Vastgepind: oudere versies wijzen `sonic-3` af en nieuwere kunnen de payload
// veranderen. De versie hoort bij de payloadvorm hieronder, niet los daarvan.
const API_VERSION = '2025-04-16';

export interface CartesiaOptions {
  readonly apiKey: string;
  /** sonic-3 is het huidige model; sonic, sonic-2 en sonic-turbo zijn uitgefaseerd. */
  readonly model?: string;
  readonly sampleRate?: number;
}

export class CartesiaTtsStream implements TtsStream {
  private readonly handlers = new Map<string, Function[]>();
  private socket: WebSocket | null = null;
  private contextId = '';
  private seq = 0;
  private emittedMs = 0;
  private cancelled = false;
  private turn = 0;

  constructor(
    private readonly config: Required<CartesiaOptions>,
    private readonly voiceOptions: TtsOptions,
  ) {}

  async connect(): Promise<void> {
    const url = `${WS_URL}?api_key=${encodeURIComponent(this.config.apiKey)}&cartesia_version=${API_VERSION}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => reject(new Error('Cartesia: verbinding mislukt'));
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('error', () => this.emit('error', new Error('Cartesia: socketfout')));
    this.newContext();
  }

  /** Elke beurt een eigen context, zodat annuleren precies deze beurt raakt. */
  private newContext(): void {
    this.turn += 1;
    this.contextId = `turn-${this.turn}-${Math.random().toString(36).slice(2, 10)}`;
    this.emittedMs = 0;
    this.seq = 0;
    this.cancelled = false;
  }

  private onMessage(raw: string): void {
    let message: { type?: string; data?: string; context_id?: string; error?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // Een late chunk van een geannuleerde context negeren we; die is nooit gehoord.
    if (message.context_id && message.context_id !== this.contextId) return;
    if (this.cancelled) return;

    if (message.type === 'chunk' && message.data) {
      const bytes = Buffer.from(message.data, 'base64');
      const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
      const durationMs = (pcm.length / this.config.sampleRate) * 1000;
      this.emittedMs += durationMs;
      this.emit('audio', { pcm, seq: this.seq++, durationMs });
    } else if (message.type === 'done') {
      this.emit('done');
    } else if (message.type === 'error') {
      this.emit('error', new Error(`Cartesia: ${message.error ?? 'onbekende fout'}`));
    }
  }

  say(text: string): void {
    if (this.cancelled || !this.socket) return;
    this.socket.send(
      JSON.stringify({
        model_id: this.config.model,
        transcript: text,
        voice: { id: this.voiceOptions.voiceId },
        language: this.voiceOptions.language,
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: this.config.sampleRate,
        },
        context_id: this.contextId,
        // De beurt kan nog meer zinnen krijgen; pas bij flush() is hij compleet.
        continue: true,
      }),
    );
  }

  /**
   * Sluit de beurt af zonder te annuleren: er komt geen tekst meer bij.
   *
   * Het bericht moet de volledige specificatie bevatten, ook al is de transcript leeg.
   * Een kaal `{context_id, continue:false}` wordt afgewezen met "invalid voice
   * specification" — een foutmelding die niets zegt over de werkelijke oorzaak.
   */
  flush(): void {
    if (this.cancelled || !this.socket) return;
    this.socket.send(
      JSON.stringify({
        model_id: this.config.model,
        transcript: '',
        voice: { id: this.voiceOptions.voiceId },
        language: this.voiceOptions.language,
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',
          sample_rate: this.config.sampleRate,
        },
        context_id: this.contextId,
        continue: false,
      }),
    );
  }

  async cancel(): Promise<{ spokenMs: number }> {
    const spokenMs = Math.round(this.emittedMs);
    this.cancelled = true;

    if (this.socket?.readyState === WebSocket.OPEN) {
      // Server stopt met genereren voor deze context. De socket blijft open voor de
      // volgende beurt — dat is precies waarom we per beurt een context gebruiken.
      this.socket.send(JSON.stringify({ context_id: this.contextId, cancel: true }));
    }

    this.newContext();
    return { spokenMs };
  }

  /** Voorbereiden op de volgende beurt zonder te annuleren. */
  nextTurn(): void {
    this.newContext();
  }

  on<E extends keyof TtsEvents>(event: E, handler: TtsEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Function);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async close(): Promise<void> {
    this.socket?.close();
    this.socket = null;
  }
}

export class CartesiaTtsProvider implements TextToSpeechProvider {
  readonly id = 'cartesia';
  private readonly config: Required<CartesiaOptions>;

  constructor(options: CartesiaOptions) {
    this.config = {
      apiKey: options.apiKey,
      model: options.model ?? 'sonic-3',
      sampleRate: options.sampleRate ?? 16_000,
    };
  }

  async open(options: TtsOptions): Promise<TtsStream> {
    const stream = new CartesiaTtsStream(this.config, options);
    await stream.connect();
    return stream;
  }
}
