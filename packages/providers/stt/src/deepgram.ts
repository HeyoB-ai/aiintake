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
 * Het interval waarbinnen een gat een afkapping kán zijn.
 *
 * ## Waarom dit één ding is en geen twee losse grenzen
 *
 * Dit is de derde ronde aan deze detectie. Ronde één zette een bovengrens op de ene
 * detector, ronde twee ontdekte dat de andere detector er geen had, ronde drie dat de
 * ondergrens ontbrak — een gat van 0 ms werd als afkapping gemeld. Telkens was de
 * gerapporteerde waarde het symptoom en de verspreide definitie de oorzaak: het interval
 * stond op drie plaatsen met drie verschillende regels.
 *
 * Daarom staat het hier als één begrip, wordt het op één plek toegepast, en leveren de
 * detectoren alleen nog kandidaten. Een vierde randgeval hoort door de vórm te worden
 * afgevangen en niet door een vierde patch.
 *
 * ## De ondergrens
 *
 * Een afkapping veronderstelt een stilte om in te knippen. Deepgram sluit een beurt af na
 * `endpointing_ms` aan stilte, dus bij elke knip die wij maken hoort er een pauze te
 * zitten. Een "gat" van nul milliseconde betekent dat twee tijdstempels hetzelfde moment
 * beschrijven — twee segmenten die een grens delen — en niet dat er een pauze is
 * waargenomen. Vijftig milliseconde is de marge waaronder we die twee niet kunnen
 * onderscheiden.
 *
 * ## De bovengrens
 *
 * Definitioneel begrensd door `utterance_end_ms`: bij precies dat gat besluit Deepgram
 * zélf dat de uitspraak voorbij is, dus wat daarna komt is een nieuwe uitspraak. De
 * getunede waarde van 600 ms ligt daaronder, en die relatie wordt hieronder afgedwongen
 * in plaats van in twee constanten herhaald. Verlaagt iemand `utterance_end_ms`, dan zakt
 * het interval mee.
 */
const CONTINUATION_MIN_GAP_MS = 50;
const CONTINUATION_MAX_GAP_MS = 600;

export interface ContinuationInterval {
  readonly minMs: number;
  readonly maxMs: number;
}

/** Het geldige interval, afgeleid van de configuratie in plaats van ernaast gezet. */
export function continuationInterval(utteranceEndMs: number): ContinuationInterval {
  return {
    minMs: CONTINUATION_MIN_GAP_MS,
    // `min`, want de getunede waarde mag nooit boven de definitionele grens uitkomen.
    maxMs: Math.min(CONTINUATION_MAX_GAP_MS, utteranceEndMs),
  };
}

/** Eén predicaat. Beide detectoren gaan hier doorheen, en elke toekomstige ook. */
export function isPlausibleContinuationGap(gapMs: number, interval: ContinuationInterval): boolean {
  return Number.isFinite(gapMs) && gapMs >= interval.minMs && gapMs <= interval.maxMs;
}

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
  /** Aantal `Results`-berichten in de lopende beurt; alleen om een lege beurt te duiden. */
  private resultatenInBeurt = 0;
  /**
   * De langste transcripttekst die in deze beurt langskwam, in tekens.
   *
   * Alleen de lengte, nooit de tekst: §14 verbiedt transcriptfragmenten in logs, en voor
   * het onderscheid dat dit veld moet maken is de lengte genoeg. Nul betekent dat de
   * herkenner geen enkel woord heeft gezien; meer dan nul bij een lege beurt betekent dat
   * er wél woorden waren en dat ze onderweg zijn verdwenen.
   */
  private tekensInBeurt = 0;
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

    /*
     * De waarden die werkelijk de URL in gaan, niet die uit de configuratie.
     *
     * "Staat de drempel aan?" was alleen te beantwoorden door de code te lezen: de
     * opstartbanner toont wat er is gelezen, en daartussen zitten drie doorgeefpunten. Dit is
     * het laatste moment waarop het nog te veranderen is, dus wat hier staat is wat Deepgram
     * krijgt. Geen sleutel in het log — die zit in de querystring en hoort daar te blijven.
     */
    // eslint-disable-next-line no-console
    console.log(
      `  STT: ${this.config.model} · endpointing ${this.config.endpointingMs} ms · ` +
        `utterance_end ${this.config.utteranceEndMs} ms · ${this.config.sampleRate} Hz`,
    );

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
      if (this.closedTurnEndSec > 0 && Number.isFinite(utteranceEnd)) {
        // Alleen een kandidaat. Of dit gat een afkapping kán zijn, beslist het interval —
        // niet deze detector.
        this.reportContinuation('', (utteranceEnd - this.closedTurnEndSec) * 1000, 'utterance_end');
      }

      // Vangnet: het laatste woord is niet als speech_final doorgekomen, maar het gat
      // tussen woordtijdstempels is groot genoeg om de beurt af te sluiten.
      this.endTurn('utterance_end');
      return;
    }

    if (message.type === 'Results') {
      const text = message.channel?.alternatives?.[0]?.transcript ?? '';
      // Tellen vóór de lege-tekstzeef: een Results zonder transcript is precies het
      // geval dat een lege beurt verklaart, en dat wil je terugzien in de melding.
      this.resultatenInBeurt += 1;
      if (text.length > this.tekensInBeurt) this.tekensInBeurt = text.length;

      /*
       * Een lege `speech_final` sluit de beurt óók.
       *
       * Hier stond `if (!text) return;` vóór deze tak, en dat had een gevolg dat niemand
       * had bedoeld: een `speech_final` zonder transcript bereikte `endTurn` nooit. De
       * beurt bleef openstaan tot het UtteranceEnd-vangnet hem een seconde later sloot, en
       * in die seconde bleef `speaking` op true. Zolang dat zo is, onderdrukt de tak
       * hierboven élke volgende `SpeechStarted` — de barge-in-trigger. De cliënt die in dat
       * gat begint te praten, wordt niet gehoord als onderbreking.
       *
       * Deze regel kost niets en verandert niets aan wat er in het transcript belandt: er
       * was geen tekst, dus er valt niets te verliezen. Wat hij wél doet is de beurt
       * afsluiten op het moment dat Deepgram zegt dat hij klaar is.
       */
      if (message.is_final && !text) {
        if (message.speech_final) this.endTurn('speech_final');
        return;
      }
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
          // Alleen een kandidaat; het interval beslist. Zie continuationInterval().
          this.reportContinuation(text, (start - this.closedTurnEndSec) * 1000, 'word_gap');
        }

        this.pending = this.pending ? `${this.pending} ${text}` : text;
        this.emit('final', text);
        if (message.speech_final) this.endTurn('speech_final');
      } else {
        /*
         * De spraakduur, uit de woordtijdstempels — en nadrukkelijk niet uit `duration`.
         *
         * Drie grootheden lijken hier op elkaar en twee ervan zijn verkeerd:
         *
         *   wandklok    `now() - startOfTurnAt`. Netwerkretour plus de cadans van de
         *               leverancier. Gemeten 565-2778 ms, en omgekeerd evenredig met hoeveel er
         *               gesproken is. Dit was de oude `speechMs` (risico 21).
         *   `duration`  de lengte van het geanalyseerde venster. Gemeten 2380 ms voor een hele
         *               zin en 2000 ms voor een enkel woord — nauwelijks onderscheidend, want
         *               het venster domineert de spraak erin.
         *   `words`     het einde van het laatste woord min het begin van het eerste. Gemeten
         *               0,96 s bij twee woorden, 1,52 bij drie, 2,32 bij zes, 3,68 bij negen.
         *               Dit is spraakduur.
         *
         * Dat interims die woordenlijst meedragen is nagemeten en niet aangenomen. Ontbreekt
         * hij, dan gaat er geen meta mee: liever niets zeggen dan een getal dat iets anders
         * meet.
         */
        const woorden = message.channel?.alternatives?.[0]?.words ?? [];
        const eersteWoord = woorden[0];
        const laatsteWoord = woorden[woorden.length - 1];
        if (
          eersteWoord &&
          laatsteWoord &&
          Number.isFinite(eersteWoord.start) &&
          Number.isFinite(laatsteWoord.end)
        ) {
          this.emit('partial', text, {
            speechMs: Math.max(0, Math.round((laatsteWoord.end - eersteWoord.start) * 1000)),
          });
        } else {
          this.emit('partial', text);
        }
      }
    }
  }

  private endTurn(endedBy: 'speech_final' | 'utterance_end'): void {
    const text = this.pending.trim();
    const speechEndedAt = this.streamStartedAt + this.lastWordEndSec * 1000;
    const resultaten = this.resultatenInBeurt;
    const tekensGezien = this.tekensInBeurt;

    this.pending = '';
    this.speaking = false;
    this.resultatenInBeurt = 0;
    this.tekensInBeurt = 0;

    if (!text) {
      this.lastWordEndSec = 0;
      /*
       * Hier stond een kale `return`.
       *
       * Deepgram meldt SpeechStarted op energie en niet op taal, dus een beurt kan
       * beginnen en eindigen zonder één woord: een kuch, een deur, of spraak die de
       * herkenner niet kon lezen. Dat verdween spoorloos — geen event, geen melding — en
       * van buiten is dat niet te onderscheiden van een cliënt die niets zei.
       *
       * Dat onderscheid doet ertoe op precies één moment: als de cliënt praat om iets
       * recht te zetten. Verdwijnt die uitspraak hier, dan blijft de oorspronkelijke,
       * foute bewering in het dossier staan mét een kloppend citaat. Zie RISICOS.md
       * risico 16.
       */
      this.emit('empty_turn', { endedBy, resultaten, tekensGezien });
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
    // Het enige punt waar over het interval wordt beslist. Beide detectoren komen hier
    // langs met een kandidaat; wat buiten het interval valt is geen afkapping.
    //
    // Een gat buiten het interval wél melden is niet neutraal: het plakt twee losse
    // uitspraken aan elkaar. De detectie bestaat om stil dataverlies te repareren en zou
    // het dan zelf veroorzaken.
    // Afronden vóór de vergelijking, niet erna.
    //
    // De gaten komen uit een aftrekking van twee floats: `2.05 - 2` levert
    // 49,99999999999982 ms op en niet 50. Precies op de grens beslist dan de
    // drijvende-kommarepresentatie in plaats van de regel — en welke kant het uitvalt
    // hangt af van de waarden die er toevallig in gaan. De vormtest ving dit meteen.
    const afgerond = Math.round(gapMs);
    if (!isPlausibleContinuationGap(afgerond, continuationInterval(this.config.utteranceEndMs))) {
      this.closedTurnEndSec = 0;
      this.closedTurnText = '';
      return;
    }

    const closed = this.closedTurnText;
    this.closedTurnEndSec = 0;
    this.closedTurnText = '';

    const fullUtterance = text ? `${closed} ${text}`.trim() : closed;
    this.emit('turn_continued', text, { gapMs: afgerond, detectedBy, fullUtterance });
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
