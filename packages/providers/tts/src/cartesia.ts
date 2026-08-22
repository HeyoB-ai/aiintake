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

/**
 * Aanloopstilte wegsnijden.
 *
 * Cartesia zet vóór het eerste woord stilte, en die is niet vast: dezelfde zin leverde in
 * drie achtereenvolgende syntheses 548, 107 en 227 ms op. Het is dus gegenereerde prosodie
 * en geen padding die met een parameter uit te zetten is — de API accepteert onbekende
 * velden bovendien stilzwijgend, dus er valt ook niets aan af te lezen.
 *
 * In productie gaat die stilte gewoon naar de avatar en wacht de cliënt hem uit. Dat is
 * geen meetartefact maar ervaren vertraging, en het is de grootste post die volledig in
 * ons eigen deel van de keten zit.
 *
 * **Alleen vóór het eerste geluid, nooit ertussen.** Stilte binnen een beurt is prosodie:
 * de pauze tussen twee zinnen, de adem voor een bijzin. Die wegsnijden zou van de
 * assistent een ratelaar maken, en het zou dataverlies zijn van dezelfde soort als
 * risico 2 — alleen dan aan de uitgaande kant.
 */
const AUDIBLE_THRESHOLD = 0.003;
/**
 * Wat we vóór het eerste hoorbare sample laten staan.
 *
 * Een medeklinker begint zacht en loopt op. Precies op het eerste sample boven de drempel
 * snijden knipt die aanzet eraf en levert een harde inzet op die klinkt als een fout.
 */
const KEEP_LEAD_MS = 20;
/**
 * Bovengrens aan wat er weg mag.
 *
 * Zou er ooit een beurt binnenkomen die veel langer stil blijft, dan is er iets anders aan
 * de hand dan prosodie, en dan hoort dat zichtbaar te worden in plaats van weggesneden.
 */
const MAX_TRIM_MS = 2000;

export class CartesiaTtsStream implements TtsStream {
  private readonly handlers = new Map<string, Function[]>();
  private socket: WebSocket | null = null;
  private contextId = '';
  private seq = 0;
  private emittedMs = 0;
  private cancelled = false;
  private turn = 0;
  /** Zoeken we nog naar het eerste hoorbare sample van deze beurt? */
  private trimming = true;
  /** Hoeveel aanloopstilte deze beurt is weggesneden. */
  private trimmedMs = 0;

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
    this.trimming = true;
    this.trimmedMs = 0;
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
      const ruw = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
      const pcm = this.trimming ? this.trimLeading(ruw) : ruw;
      if (pcm.length === 0) return;

      const durationMs = (pcm.length / this.config.sampleRate) * 1000;
      this.emittedMs += durationMs;
      this.emit('audio', { pcm, seq: this.seq++, durationMs });
    } else if (message.type === 'done') {
      this.emit('done');
    } else if (message.type === 'error') {
      this.emit('error', new Error(`Cartesia: ${message.error ?? 'onbekende fout'}`));
    }
  }

  /**
   * Snijdt de stilte vóór het eerste geluid weg. Alleen aan het begin van een beurt.
   *
   * Levert een leeg fragment op als deze chunk volledig stil is; dan telt hij als
   * weggesneden en wordt hij niet doorgegeven.
   */
  private trimLeading(pcm: Int16Array): Int16Array {
    const grens = AUDIBLE_THRESHOLD * 32767;
    let eerste = 0;
    while (eerste < pcm.length && Math.abs(pcm[eerste]!) <= grens) eerste += 1;

    const chunkMs = (pcm.length / this.config.sampleRate) * 1000;

    if (eerste >= pcm.length) {
      // Volledig stil. Boven de bovengrens stoppen we met snijden en laten we de rest
      // staan: dan is er iets anders aan de hand dan prosodie.
      if (this.trimmedMs + chunkMs > MAX_TRIM_MS) {
        this.trimming = false;
        return pcm;
      }
      this.trimmedMs += chunkMs;
      return new Int16Array(0);
    }

    // Gevonden. Een stukje aanloop laten staan zodat een zachte inzet niet wordt afgekapt.
    const lead = Math.round((KEEP_LEAD_MS / 1000) * this.config.sampleRate);
    const vanaf = Math.max(0, eerste - lead);
    this.trimming = false;
    this.trimmedMs += (vanaf / this.config.sampleRate) * 1000;
    return vanaf === 0 ? pcm : pcm.slice(vanaf);
  }

  /** Hoeveel aanloopstilte er deze beurt is weggesneden. */
  trimmedLeadingMs(): number {
    return Math.round(this.trimmedMs);
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
