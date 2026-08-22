import type { SpeechToTextProvider, SttEvents, SttOptions, SttStream } from './contract';

/**
 * Deepgram streaming STT.
 *
 * **Modelkeuze, en waarom die afwijkt van het architectuurdocument.** Dat document koos
 * Deepgram om Flux, vanwege model-native end-of-turn onder ~300 ms. Flux blijkt geen
 * Nederlands te doen — hij komt in de modellenlijst van dit account niet voor, in geen
 * enkele taal. Nederlands loopt via `nova-3-general` (nl, nl-BE, nl-NL).
 *
 * Gevolg: turn-taking gaat niet via het model maar via endpointing. Dat is precies het
 * mechanisme waar het document voor waarschuwde — een stiltedrempel betaal je in élke
 * beurt. We beperken de schade met twee knoppen:
 *
 *   `endpointing`      stilte in ms voordat een resultaat `speech_final` wordt
 *   `utterance_end_ms` gat tussen woordtijdstempels dat een UtteranceEnd oplevert
 *
 * 300 ms endpointing is agressief maar haalbaar bij een gesprek waarin de cliënt aan
 * het woord is; de UtteranceEnd is het vangnet als het laatste woord wegvalt.
 */

const WS_URL = 'wss://api.deepgram.com/v1/listen';

export interface DeepgramOptions {
  readonly apiKey: string;
  readonly model?: string;
  /** Stilte in ms voor speech_final. Lager = sneller, maar knipt eerder door een pauze. */
  readonly endpointingMs?: number;
  readonly utteranceEndMs?: number;
  readonly sampleRate?: number;
}

export class DeepgramSttStream implements SttStream {
  private readonly handlers = new Map<string, Function[]>();
  private socket: WebSocket | null = null;
  private speaking = false;
  /** Wat er sinds de laatste beurt aan finals is binnengekomen. */
  private pending = '';

  constructor(
    private readonly config: Required<DeepgramOptions>,
    private readonly options: SttOptions,
  ) {}

  async connect(): Promise<void> {
    const params = new URLSearchParams({
      model: this.config.model,
      language: this.options.language,
      encoding: 'linear16',
      sample_rate: String(this.config.sampleRate),
      channels: '1',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      // SpeechStarted is onze vroege barge-in-trigger.
      vad_events: 'true',
      endpointing: String(this.config.endpointingMs),
      utterance_end_ms: String(this.config.utteranceEndMs),
    });

    // Keyterm prompting voor juridisch jargon. Deepgram accepteert het parameter
    // meerdere keren; wordt het genegeerd voor deze taal, dan kost het niets.
    for (const term of this.options.keyterms) params.append('keyterm', term);

    // Node's WebSocket kent geen custom headers. Deepgram accepteert de key daarom als
    // subprotocol — dezelfde weg die browserclients gebruiken.
    const socket = new WebSocket(`${WS_URL}?${params}`, ['token', this.config.apiKey]);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => reject(new Error('Deepgram: verbinding mislukt'));
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('error', () => this.emit('error', new Error('Deepgram: socketfout')));
  }

  private onMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === 'SpeechStarted') {
      if (!this.speaking) {
        this.speaking = true;
        this.emit('start_of_turn');
      }
      return;
    }

    if (message.type === 'UtteranceEnd') {
      // Vangnet: het laatste woord is niet als speech_final doorgekomen, maar het gat
      // tussen woordtijdstempels is groot genoeg om de beurt af te sluiten.
      this.endTurn();
      return;
    }

    if (message.type === 'Results') {
      const text = message.channel?.alternatives?.[0]?.transcript ?? '';
      if (!text) return;

      if (message.is_final) {
        this.pending = this.pending ? `${this.pending} ${text}` : text;
        this.emit('final', text);
        if (message.speech_final) this.endTurn();
      } else {
        this.emit('partial', text);
      }
    }
  }

  private endTurn(): void {
    const text = this.pending.trim();
    this.pending = '';
    this.speaking = false;
    if (text) this.emit('end_of_turn', text);
  }

  push(pcm: Int16Array): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
    );
  }

  /** Vertelt Deepgram dat de audio op is, zodat hij het laatste resultaat afmaakt. */
  finalise(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'Finalize' }));
    }
  }

  on<E extends keyof SttEvents>(event: E, handler: SttEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Function);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async close(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
    }
    this.socket?.close();
    this.socket = null;
  }
}

export class DeepgramSttProvider implements SpeechToTextProvider {
  readonly id = 'deepgram';
  private readonly config: Required<DeepgramOptions>;

  constructor(options: DeepgramOptions) {
    this.config = {
      apiKey: options.apiKey,
      // Niet 'flux': die bestaat niet voor Nederlands. Zie de toelichting bovenaan.
      model: options.model ?? 'nova-3',
      endpointingMs: options.endpointingMs ?? 300,
      utteranceEndMs: options.utteranceEndMs ?? 1000,
      sampleRate: options.sampleRate ?? 16_000,
    };
  }

  async connect(options: SttOptions): Promise<SttStream> {
    const stream = new DeepgramSttStream(this.config, options);
    await stream.connect();
    return stream;
  }
}
