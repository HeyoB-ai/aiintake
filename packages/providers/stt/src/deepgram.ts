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

/**
 * Een nieuw segment dat binnen dit gat op de vorige beurt volgt, hoorde bij dezelfde
 * uitspraak. Ruim onder `utterance_end_ms` (1000 ms) gekozen: een cliënt die echt
 * opnieuw inzet, heeft eerst het antwoord afgewacht en zit daar altijd boven.
 */
const CONTINUATION_MAX_GAP_SEC = 0.6;

/** Marge tegen afrondingsruis in de tijdstempels. */
const CONTINUATION_EPSILON_SEC = 0.05;

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
  /** Wandkloktijd waarop de stream openging; ankerpunt voor de streamtijdstempels. */
  private streamStartedAt = 0;
  /** Einde van het laatste woord, in seconden vanaf streamstart. */
  private lastWordEndSec = 0;

  // --- detectie van een te vroege knip (RISICOS.md risico 2)
  /** Waar de vorige beurt werd afgekapt, in streamseconden. 0 = geen open geval. */
  private closedTurnEndSec = 0;
  /** De tekst van die beurt, zodat we de volledige uitspraak kunnen teruggeven. */
  private closedTurnText = '';

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
    // Flux draait op /v2/listen en deze adapter spreekt /v1. Zonder deze controle krijg
    // je een kale "non-101 status code" en zoek je het in de key of het netwerk, terwijl
    // het een modelnaam is. Zie ADR-0009 voor waarom Flux hier sowieso niet past.
    if (/^flux/i.test(this.config.model ?? '')) {
      throw new Error(
        `Deepgram: model "${this.config.model}" is een Flux-model en werkt alleen op ` +
          '/v2/listen; deze adapter spreekt /v1. Flux kent bovendien geen language-parameter ' +
          'en is Engelstalig, dus voor Nederlands is nova-3 de keuze. Zet DEEPGRAM_MODEL=nova-3.',
      );
    }

    const socket = new WebSocket(`${WS_URL}?${params}`, ['token', this.config.apiKey]);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.removeEventListener('error', onError);
        resolve();
      };
      // De oorzaak meenemen. Een kale "verbinding mislukt" laat je gissen tussen een
      // verkeerde key, een onbereikbare host en een geweigerd model — en dat is precies
      // het soort melding waar een half uur in gaat zitten.
      const onError = (event: unknown) => {
        const detail =
          (event as { message?: string; error?: { message?: string } })?.message ??
          (event as { error?: { message?: string } })?.error?.message ??
          'geen details van de socket';
        reject(new Error(`Deepgram: verbinding mislukt — ${detail}`));
      };
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
    });

    this.streamStartedAt = performance.now();
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
      // Tweede, onafhankelijke aanwijzing dat we te vroeg knipten: UtteranceEnd draagt
      // zijn eigen last_word_end. Ligt die voorbij het punt waarop wij afsloten, dan is
      // er ná onze knip nog gesproken.
      const utteranceEnd = Number(message.last_word_end ?? 0);
      if (
        this.closedTurnEndSec > 0 &&
        Number.isFinite(utteranceEnd) &&
        utteranceEnd > this.closedTurnEndSec + CONTINUATION_EPSILON_SEC
      ) {
        this.reportContinuation('', (utteranceEnd - this.closedTurnEndSec) * 1000, 'utterance_end');
      }

      // Vangnet: het laatste woord is niet als speech_final doorgekomen, maar het gat
      // tussen woordtijdstempels is groot genoeg om de beurt af te sluiten.
      this.endTurn('utterance_end');
      return;
    }

    if (message.type === 'Results') {
      const text = message.channel?.alternatives?.[0]?.transcript ?? '';
      if (!text) return;

      if (message.is_final) {
        // start + duration is het einde van dit segment in streamtijd. Daarmee weten we
        // wanneer de cliënt ophield met praten, en niet alleen wanneer wij dat hoorden.
        const start = Number(message.start ?? 0);
        const end = start + Number(message.duration ?? 0);
        if (Number.isFinite(end) && end > this.lastWordEndSec) this.lastWordEndSec = end;

        // Sluit dit segment tijdgewijs aan op een net afgesloten beurt? Dan hoorde het
        // daarbij en was de knip te vroeg. Een échte nieuwe beurt heeft een groter gat:
        // de cliënt heeft dan geluisterd en opnieuw ingezet.
        if (this.closedTurnEndSec > 0 && Number.isFinite(start)) {
          const gapSec = start - this.closedTurnEndSec;
          if (gapSec >= 0 && gapSec < CONTINUATION_MAX_GAP_SEC) {
            this.reportContinuation(text, gapSec * 1000, 'word_gap');
          }
        }

        this.pending = this.pending ? `${this.pending} ${text}` : text;
        this.emit('final', text);
        if (message.speech_final) this.endTurn('speech_final');
      } else {
        this.emit('partial', text);
      }
    }
  }

  private endTurn(endedBy: 'speech_final' | 'utterance_end'): void {
    const text = this.pending.trim();
    const speechEndedAt = this.streamStartedAt + this.lastWordEndSec * 1000;

    this.pending = '';
    this.speaking = false;

    if (!text) {
      this.lastWordEndSec = 0;
      return;
    }

    // Onthouden waar we afkapten, zodat het volgende segment ertegen af te zetten is.
    this.closedTurnEndSec = this.lastWordEndSec;
    this.closedTurnText = text;
    this.lastWordEndSec = 0;

    this.emit('end_of_turn', text, { speechEndedAt, endedBy });
  }

  /**
   * Meldt dat de vorige knip te vroeg was.
   *
   * Eén melding per geval: is het geval eenmaal gerapporteerd, dan hoort de rest van de
   * uitspraak bij de lopende beurt en is er niets nieuws meer te melden.
   */
  private reportContinuation(
    text: string,
    gapMs: number,
    detectedBy: 'word_gap' | 'utterance_end',
  ): void {
    // Harde bovengrens, en geen gewogen afweging.
    //
    // Een gat groter dan `utterance_end_ms` kán per definitie geen afkapping zijn: bij
    // precies dat gat besluit Deepgram zélf dat de uitspraak voorbij is. Wat daarna komt
    // is een nieuwe uitspraak, hoe kort de pauze ook voelde.
    //
    // Deze controle staat hier en niet bij de twee detectoren, omdat hij voor elke
    // detector geldt — ook voor een toekomstige. De word_gap-detector had zijn eigen
    // grens van 600 ms; de utterance_end-detector had er geen enkele en meldde live een
    // "afkapping" met een gat van 7300 ms. Twee uitspraken die zeven seconden uit elkaar
    // lagen werden aan elkaar geplakt, en dat is geen dataverlies repareren maar
    // dataverlies veroorzaken: de eerste uitspraak kreeg er tekst bij die er niet bij
    // hoorde.
    const bovengrensMs = this.config.utteranceEndMs;
    if (gapMs > bovengrensMs) {
      this.closedTurnEndSec = 0;
      this.closedTurnText = '';
      return;
    }

    const closed = this.closedTurnText;
    this.closedTurnEndSec = 0;
    this.closedTurnText = '';

    const fullUtterance = text ? `${closed} ${text}`.trim() : closed;
    this.emit('turn_continued', text, { gapMs: Math.round(gapMs), detectedBy, fullUtterance });
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
