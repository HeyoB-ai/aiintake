import { AanloopSnijder, base64NaarPcm } from './aanloopstilte';
import type { TextToSpeechProvider, TtsEvents, TtsOptions, TtsStream } from './contract';
import { SpreektempoWacht } from './spreektempo';

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
  /**
   * Aanloopstilte wegsnijden. Standaard aan.
   *
   * Uit te zetten om met eigen oren te vergelijken: een klik hoor je, en op de golfvorm is
   * hij soms te klein om op te vallen.
   */
  readonly trimLeadingSilence?: boolean;
}

export class CartesiaTtsStream implements TtsStream {
  private readonly handlers = new Map<string, Function[]>();
  private socket: WebSocket | null = null;
  private contextId = '';
  private seq = 0;
  private emittedMs = 0;
  private cancelled = false;
  private turn = 0;
  private readonly snijder: AanloopSnijder;
  private readonly tempo = new SpreektempoWacht('Cartesia');

  constructor(
    private readonly config: Required<CartesiaOptions>,
    private readonly voiceOptions: TtsOptions,
  ) {
    this.snijder = new AanloopSnijder(config.sampleRate, config.trimLeadingSilence);
  }

  async connect(): Promise<void> {
    /*
     * Hier stond een `throw` voor elke rate behalve 16000.
     *
     * De aanleiding was een meting: dezelfde zin gaf via REST 2,37 s op zowel 16000 als
     * 24000 — het aantal samples schaalde daar netjes mee — maar via de WebSocket bleef het
     * aantal samples gelijk. Wie dan 24000 instelt, labelt 16 kHz-audio als 24 kHz en krijgt
     * spraak die anderhalf keer te snel loopt. Dat hoorde te knallen en niet stilletjes te
     * gebeuren, vandaar de uitzondering.
     *
     * Die premisse klopt niet meer. Gemeten op 26 augustus 2026 met `pnpm diag:tts-vergelijk`,
     * twee onafhankelijke toetsen:
     *
     *   spreektempo   24 kHz over de WebSocket geeft 3,83 woorden per seconde tegen 3,41 voor
     *                 REST op dezelfde tekst. Werd de parameter genegeerd, dan zou de
     *                 berekende duur twee derde van de echte zijn en het tempo boven de 5 w/s
     *                 uitkomen. Dat gebeurt niet.
     *   samples       128050 tegen 194676 samples op 16 tegen 24 kHz, drie runs per rate:
     *                 verhouding 1,52. Genegeerd zou 1,00 opleveren.
     *
     * Waarom het vandaag anders uitvalt weet niemand; het kan een wijziging bij Cartesia zijn.
     * De oorspronkelijke meting is niet in twijfel getrokken — zie de correctie bovenaan
     * risico 12, waar dit als omgekeerd resultaat staat en niet als nieuw resultaat.
     *
     * Wat blijft staan is de eis dat een verkeerde rate niet stil mag zijn. Daarom geen
     * blinde acceptatie maar een controle op de uitkomst: `bewaakSpreektempo()` hieronder
     * kijkt aan het eind van de eerste beurt of het tempo klopt met wat we hebben gevraagd.
     */
    const url = `${WS_URL}?api_key=${encodeURIComponent(this.config.apiKey)}&cartesia_version=${API_VERSION}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError);
        resolve();
      };
      /*
       * De reden erbij, niet alleen "mislukt".
       *
       * Een WebSocket-`error` draagt geen HTTP-status: bij een mislukte handshake krijg je
       * een leeg event. "Cartesia: verbinding mislukt" is dan alles wat er in het log komt,
       * en dat kan van alles betekenen — verkeerde sleutel, netwerk, of iets heel anders.
       *
       * Het was in de praktijk `402 Model credits limit reached`, en die melding zoeken
       * kostte een omweg langs de afsluitlogica omdat het symptoom eruitzag als een
       * verbinding die zomaar dichtviel. Daarom vragen we het bij een fout alsnog na op
       * hun REST-endpoint: dat geeft wél een status en een tekst.
       */
      const onError = () => {
        void this.diagnose().then((reden) =>
          reject(new Error(`Cartesia: verbinding mislukt${reden ? ` — ${reden}` : ''}`)),
        );
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    socket.addEventListener('message', (event) => this.onMessage(String(event.data)));
    socket.addEventListener('error', () => this.emit('error', new Error('Cartesia: socketfout')));
    this.newContext();
  }

  /**
   * Waarom weigerde hij? Vraagt het na langs de REST-kant, die wél een status geeft.
   *
   * Bewust een minimale aanvraag en een korte timeout: dit draait op het moment dat er al
   * iets mis is, en het mag de foutmelding niet ophouden. Lukt het niet, dan blijft de
   * melding zoals hij was — een diagnose die zelf faalt hoort geen nieuwe fout te worden.
   */
  private async diagnose(): Promise<string | null> {
    const kop = {
      'X-API-Key': this.config.apiKey,
      'Cartesia-Version': API_VERSION,
      'Content-Type': 'application/json',
    };
    try {
      // Eerst een stem ophalen. Die is verplicht in het syntheseverzoek en de configuratie
      // van deze klasse draagt hem niet — hij gaat per beurt mee. Deze aanroep zegt
      // meteen iets: 401 hier betekent dat de sleutel het probleem is.
      const stemmen = await fetch('https://api.cartesia.ai/voices', {
        headers: kop,
        signal: AbortSignal.timeout(4_000),
      });
      if (!stemmen.ok) {
        return `hun API weigert ook de stemmenlijst: HTTP ${stemmen.status}`;
      }
      const lijst = (await stemmen.json()) as { data?: { id?: string }[] };
      const stem = lijst.data?.[0]?.id;
      if (!stem) return 'hun API gaf geen stemmen terug';

      const res = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: kop,
        body: JSON.stringify({
          model_id: this.config.model,
          transcript: '.',
          voice: { mode: 'id', id: stem },
          language: 'en',
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16_000 },
        }),
        signal: AbortSignal.timeout(4_000),
      });
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
    this.emittedMs = 0;
    this.seq = 0;
    this.cancelled = false;
    this.snijder.reset();
    this.tempo.reset();
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
      /*
       * Uitlijning, en waarom dit er staat terwijl het probleem zich niet voordeed.
       *
       * Hier stond `new Int16Array(bytes.buffer, bytes.byteOffset, …)` rechtstreeks op de
       * Buffer. Daar zitten twee aannames in die geen van beide gegarandeerd zijn:
       *
       *  - dat `byteOffset` even is. Node deelt Buffers uit een pool; bij een oneven offset
       *    gooit `new Int16Array` een RangeError en is de chunk weg.
       *  - dat `length` even is. Bij een oneven lengte viel de laatste byte onder tafel en
       *    begon de vólgende chunk op de verkeerde bytegrens. Vanaf dat punt worden twee
       *    helften van verschillende samples aan elkaar geplakt, en dat is ruis — geen
       *    subtiele vervorming.
       *
       * Gemeten op 26 augustus met `pnpm diag:audio`, op de zin waarmee het live misging:
       * 45 chunks, nul met een oneven lengte, nul met een oneven offset, nul bytes
       * weggegooid. Het geval deed zich dus niet voor, en dit is géén reparatie van de
       * onverstaanbare opening.
       *
       * Het blijft staan als verzekering: het hangt aan hoe de leverancier zijn chunks
       * knipt en aan de Buffer-pool van Node, en beide kunnen morgen anders zijn. De kosten
       * zijn één kopie per chunk; de fout die het uitsluit is onhoorbaar te debuggen.
       */
      const { pcm: ruw, oneven } = base64NaarPcm(message.data);
      if (oneven) {
        // Nooit stil: als dit ooit afgaat, is elke sample hierna een byte verschoven.
        this.emit(
          'error',
          new Error('Cartesia: chunk met oneven aantal bytes; de audio hierna kan scheef staan.'),
        );
      }
      const pcm = this.snijder.verwerk(ruw);
      if (pcm.length === 0) return;

      const durationMs = (pcm.length / this.config.sampleRate) * 1000;
      this.emittedMs += durationMs;
      this.emit('audio', { pcm, seq: this.seq++, durationMs });
    } else if (message.type === 'done') {
      const klacht = this.tempo.controleer(this.emittedMs, this.config.sampleRate);
      if (klacht) this.emit('error', new Error(klacht));
      this.emit('done');
    } else if (message.type === 'error') {
      this.emit('error', new Error(`Cartesia: ${message.error ?? 'onbekende fout'}`));
    }
  }

  /** Hoeveel aanloopstilte er deze beurt is weggesneden. */
  trimmedLeadingMs(): number {
    return this.snijder.weggesnedenMs;
  }

  say(text: string): void {
    if (this.cancelled || !this.socket) return;
    this.tempo.telTekst(text);
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
      trimLeadingSilence: options.trimLeadingSilence ?? true,
    };
  }

  async open(options: TtsOptions): Promise<TtsStream> {
    const stream = new CartesiaTtsStream(this.config, options);
    await stream.connect();
    return stream;
  }
}
