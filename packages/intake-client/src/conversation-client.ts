import { naarPcm16k } from '@intake/audio';

/**
 * De cliëntkant van een intakegesprek, zonder DOM en zonder framework.
 *
 * Dit is de logica die eerst als los script in `apps/agent/live/page.html` stond: microfoon
 * opnemen, ruispoort, verzenden, afspelen, barge-in, en de avatar voeden. Die stond daar
 * goed, maar wel op één plek waar niemand anders bij kon. Een tweede implementatie voor de
 * cliëntpagina zou betekenen dat barge-in daar subtiel anders werkt dan in het harnas waarin
 * we hem hebben afgesteld — en dan bewijst luisteren naar het harnas niets over het product.
 *
 * Vandaar: geen DOM-verwijzingen, geen React, alleen callbacks. Het ontwikkelharnas en de
 * cliëntpagina gebruiken hetzelfde bestand.
 *
 * ## De samplerate is niet aan ons
 *
 * `new AudioContext({ sampleRate: 16000 })` is een *verzoek*. Chrome op een desktop
 * honoreert het; Safari op iOS levert de rate van het apparaat, meestal 48000. De oude
 * pagina ging daaraan voorbij en labelde die audio gewoon als 16 kHz. Het gevolg is geen
 * ruis maar spraak die drie keer te snel bij Deepgram aankomt: die herkent dan niets, de
 * beurt eindigt nooit, en het lijkt of de spraakherkenning stuk is.
 *
 * Daarom wordt de werkelijke `ctx.sampleRate` gelezen en wordt elk blok naar 16 kHz
 * herbemonsterd met dezelfde functie die de server gebruikt.
 *
 * ## Toestemming en gebaren
 *
 * De aanroeper levert de `MediaStream`. Dat is geen luiheid maar noodzaak: op iOS moet
 * `getUserMedia` én het starten van een `AudioContext` binnen een gebruikersgebaar
 * gebeuren, en het toestemmingsscherm heeft dat gebaar al. Hem hier opnieuw opvragen zou
 * buiten dat gebaar vallen en stil falen.
 */

/** Wat de server over de socket stuurt. Zie apps/agent/live/server.ts. */
export type ServerBericht =
  | { type: 'ready'; sampleRate: number; avatar: string; anamToken?: string; avatarFout?: string }
  | { type: 'turn'; client: string; assistant: string; hud: string; interrupted?: boolean }
  | { type: 'skipped'; reden: string }
  | { type: 'clear' }
  | { type: 'endturn' }
  | { type: 'stop'; reden?: string }
  | { type: 'error'; waar: string; wat: string }
  | { type: string; [k: string]: unknown };

export type Fase = 'sessie' | 'verbonden' | 'frame';
export type FaseStand = 'wachten' | 'bezig' | 'klaar' | 'fout';

export interface GespreksBeurt {
  readonly client: string;
  readonly assistant: string;
  readonly interrupted: boolean;
  /** Alleen voor ontwikkelweergaven; nooit voor de cliënt. */
  readonly hud: string;
}

export interface ConversationClientOptions {
  readonly wsUrl: string;
  /** Microfoon, al verkregen binnen een gebruikersgebaar. */
  readonly micStream: MediaStream;
  /** Het video-element waar de avatar in komt. Zonder avatar niet nodig. */
  readonly videoElement?: HTMLVideoElement | null;
  /** Laadt de Anam-SDK. Injecteerbaar zodat de bundel er niet aan vastzit. */
  readonly laadAnamSdk?: () => Promise<{ createClient: (token: string) => AnamClient }>;
  readonly onStatus?: (tekst: string) => void;
  readonly onFase?: (fase: Fase, stand: FaseStand, fout?: string) => void;
  readonly onBeurt?: (beurt: GespreksBeurt) => void;
  readonly onSysteem?: (tekst: string) => void;
  /** Ingangsniveau 0..1, voor een meter. Loopt op audioframe-tempo. */
  readonly onNiveau?: (niveau: number, poortDicht: boolean) => void;
  readonly onSpreekt?: (aanHetWoord: 'assistent' | 'cliënt' | 'stil') => void;
  readonly onGestopt?: (reden: string) => void;
  readonly onFout?: (waar: string, wat: string) => void;
}

interface AnamAudioInput {
  sendAudioChunk(chunk: ArrayBuffer | Uint8Array | string): void;
  endSequence(): void;
}

interface AnamClient {
  streamToVideoElement(id: string): Promise<void>;
  stream(): Promise<MediaStream[]>;
  createAgentAudioInputStream(config: {
    encoding: string;
    sampleRate: number;
    channels: number;
  }): Promise<AnamAudioInput> | AnamAudioInput;
  interruptPersona(): void;
  stopStreaming(): Promise<void> | void;
  getActiveSessionId?(): string | null;
}

/**
 * Ruispoort.
 *
 * Deepgram's `endpointing` werkt op VAD over de audio: het moet stilte *horen*. Gemeten met
 * pnpm diag:speechfinal sluit een beurt bij digitale stilte na ~600 ms, bij een rustige
 * kamer pas na ~2000 ms, en bij ventilatorgeluid neemt het UtteranceEnd-vangnet het over op
 * ~2400 ms. De ruisvloer van de microfoon bepaalt dus zowel het mechanisme als de latency.
 *
 * De drempel staat laag en het sluiten heeft vertraging: zachte spraak afknippen zou
 * dataverlies zijn, en dat is wat risico 2 verbiedt. Liever ruis doorlaten dan een woord.
 */
const POORT_DREMPEL = 0.005;
const POORT_SLUIT_NA_MS = 120;
const BLOKGROOTTE = 2048;

export class ConversationClient {
  private ws: WebSocket | null = null;
  private ctxIn: AudioContext | null = null;
  private ctxUit: AudioContext | null = null;
  private proc: ScriptProcessorNode | null = null;
  private anam: AnamClient | null = null;
  private anamInvoer: AnamAudioInput | null = null;
  private bronnen: AudioBufferSourceNode[] = [];
  private volgendeStart = 0;
  private uitRate = 16_000;
  private gestopt = false;
  private opruimers: (() => void)[] = [];

  private constructor(private readonly opties: ConversationClientOptions) {}

  static async start(opties: ConversationClientOptions): Promise<ConversationClient> {
    const client = new ConversationClient(opties);
    await client.begin();
    return client;
  }

  private meld(tekst: string): void {
    this.opties.onStatus?.(tekst);
  }

  private async begin(): Promise<void> {
    /*
     * Geen `sampleRate` in de constructor.
     *
     * Vragen om 16 kHz levert op iOS niets op behalve een context die iets anders doet dan
     * je denkt. Nu lezen we wat we krijgen en rekenen we het om.
     */
    this.ctxIn = new AudioContext();
    this.ctxUit = new AudioContext();
    // Op iOS start een context in `suspended` tot een gebaar hem hervat. De aanroeper zit
    // in dat gebaar; hier alleen nog het hervatten.
    await this.ctxIn.resume().catch(() => undefined);
    await this.ctxUit.resume().catch(() => undefined);

    this.meld('verbinden…');
    const ws = new WebSocket(this.opties.wsUrl);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onclose = () => this.stop('verbinding met de server weg');
    ws.onerror = () => this.opties.onFout?.('verbinding', 'de socket gaf een fout');
    ws.onmessage = (ev) => void this.ontvang(ev);

    await new Promise<void>((klaar, mis) => {
      ws.onopen = () => klaar();
      setTimeout(() => mis(new Error('de server antwoordde niet binnen 15 seconden')), 15_000);
    });
    this.meld('verbonden — de keten wordt opgezet…');

    this.startMicrofoon();
    this.hechtOpruimHaken();
  }

  private hechtOpruimHaken(): void {
    /*
     * `pagehide` en niet alleen `beforeunload`.
     *
     * Safari op iOS slaat `beforeunload` over bij het wegvegen van een tab en bij het
     * teruggaan naar het beginscherm. `pagehide` vuurt daar wél. Allebei registreren kost
     * niets en `stop()` is idempotent.
     */
    const weg = (): void => this.stop('pagina weg');
    addEventListener('pagehide', weg);
    addEventListener('beforeunload', weg);
    this.opruimers.push(() => {
      removeEventListener('pagehide', weg);
      removeEventListener('beforeunload', weg);
    });
  }

  private async ontvang(ev: MessageEvent): Promise<void> {
    if (ev.data instanceof ArrayBuffer) {
      this.speel(new Int16Array(ev.data));
      return;
    }
    let bericht: ServerBericht;
    try {
      bericht = JSON.parse(String(ev.data)) as ServerBericht;
    } catch {
      return; // niet-JSON van de server negeren we
    }

    switch (bericht.type) {
      case 'ready':
        await this.opReady(bericht as Extract<ServerBericht, { type: 'ready' }>);
        break;
      case 'clear':
        this.stopGeluid();
        this.opties.onSpreekt?.('cliënt');
        break;
      case 'endturn':
        this.beeindigAnamBeurt();
        this.opties.onSpreekt?.('stil');
        break;
      case 'turn': {
        const t = bericht as Extract<ServerBericht, { type: 'turn' }>;
        this.opties.onBeurt?.({
          client: t.client,
          assistant: t.assistant,
          interrupted: Boolean(t.interrupted),
          hud: t.hud,
        });
        this.opties.onSpreekt?.('assistent');
        break;
      }
      case 'skipped':
        this.opties.onSysteem?.(
          `beurt overgeslagen — ${(bericht as { reden?: string }).reden ?? 'onbekend'}`,
        );
        break;
      case 'stop':
        this.stop((bericht as { reden?: string }).reden ?? 'door de server beëindigd');
        break;
      case 'error': {
        const f = bericht as Extract<ServerBericht, { type: 'error' }>;
        this.opties.onFout?.(f.waar, f.wat);
        break;
      }
      default:
        break;
    }
  }

  private async opReady(bericht: Extract<ServerBericht, { type: 'ready' }>): Promise<void> {
    if (bericht.sampleRate) this.uitRate = bericht.sampleRate;

    /*
     * Op de PROVIDER beslissen, niet op de aanwezigheid van een token.
     *
     * Anders is "het token is mislukt" niet te onderscheiden van "er was geen gezicht
     * bedoeld", en draait de pagina zonder beeld verder terwijl de server iets anders
     * meldt. Dat kostte eerder een avond zoeken in de frontend.
     */
    if (bericht.avatar === 'anam' && !bericht.anamToken) {
      this.opties.onFase?.('sessie', 'fout', bericht.avatarFout ?? 'geen sessietoken ontvangen');
      this.opties.onFout?.('avatar', bericht.avatarFout ?? 'geen sessietoken ontvangen');
      this.stop('de avatar kon niet worden opgezet');
      return;
    }

    if (bericht.anamToken) {
      this.opties.onFase?.('sessie', 'bezig');
      try {
        await this.startAvatar(bericht.anamToken);
      } catch (fout) {
        const wat = fout instanceof Error ? fout.message : String(fout);
        this.opties.onFase?.('sessie', 'fout', wat);
        this.opties.onFout?.('avatar', wat);
        this.stop('de avatar kon niet worden opgezet');
        return;
      }
    }

    this.meld('klaar — hij begint zo');
    this.stuur({ type: 'start' });
  }

  private async startAvatar(token: string): Promise<void> {
    const video = this.opties.videoElement;
    const laad = this.opties.laadAnamSdk;
    if (!video || !laad) throw new Error('geen videoelement of SDK-lader meegegeven');

    const { createClient } = await laad();
    const anam = createClient(token);
    this.anam = anam;

    // Het frame-abonnement vóór het verbinden: anders mis je het eerste frame als de
    // verbinding sneller is dan de volgende regel.
    const eersteFrame = new Promise<void>((res) => {
      // `requestVideoFrameCallback` is de enige haak die écht "er is een frame getekend"
      // betekent. Safari heeft hem sinds 15.4; daarvoor is `playing` het beste alternatief,
      // en dat zegt alleen dat het afspelen is begonnen.
      const metCallback = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      };
      if (typeof metCallback.requestVideoFrameCallback === 'function') {
        metCallback.requestVideoFrameCallback(() => res());
        return;
      }
      video.addEventListener('playing', () => res(), { once: true });
    });

    const streams = await anam.stream();
    const beeld = streams.find((s) => s.getVideoTracks().length > 0);
    if (beeld) video.srcObject = beeld;
    this.opties.onFase?.('sessie', 'klaar');
    this.opties.onFase?.('verbonden', 'klaar');

    /*
     * Expliciet `play()`, en `muted` mag niet.
     *
     * Het element heeft `autoplay`, maar met een audiotrack erbij weigert elke browser dat
     * zonder gebruikersgebaar — op iOS zonder uitzondering. De klik waarmee het gesprek is
     * gestart dekt dat af; deze aanroep maakt zichtbaar wanneer hij dat tóch niet doet, in
     * plaats van een stil zwart vlak.
     */
    try {
      await video.play();
    } catch (fout) {
      const wat = fout instanceof Error ? fout.message : String(fout);
      this.opties.onFase?.('frame', 'fout', `de browser weigert afspelen: ${wat}`);
      throw new Error(`de browser weigert het beeld af te spelen: ${wat}`);
    }

    await eersteFrame;
    this.opties.onFase?.('frame', 'klaar');

    const sessionId = anam.getActiveSessionId?.();
    // De server sluit de avatarsessie; hij kan dat betrouwbaar en deze pagina niet, want
    // een tab die wordt weggeklikt maakt geen asynchroon werk meer af.
    if (sessionId) this.stuur({ type: 'anam', sessionId });
  }

  private startMicrofoon(): void {
    const ctx = this.ctxIn;
    if (!ctx) return;

    const bron = ctx.createMediaStreamSource(this.opties.micStream);
    const proc = ctx.createScriptProcessor(BLOKGROOTTE, 1, 1);
    this.proc = proc;
    const bronRate = ctx.sampleRate;
    let stilSinds: number | null = null;

    proc.onaudioprocess = (ev) => {
      const data = ev.inputBuffer.getChannelData(0);
      let piek = 0;
      let som = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = data[i] as number;
        som += v * v;
        if (Math.abs(v) > piek) piek = Math.abs(v);
      }
      const rms = Math.sqrt(som / data.length);

      const nu = performance.now();
      if (rms > POORT_DREMPEL) stilSinds = null;
      else stilSinds ??= nu;
      const poortDicht = stilSinds !== null && nu - stilSinds >= POORT_SLUIT_NA_MS;

      const ruw = new Int16Array(data.length);
      if (!poortDicht) {
        for (let i = 0; i < data.length; i += 1) {
          ruw[i] = Math.max(-1, Math.min(1, data[i] as number)) * 32767;
        }
      }

      // Hier gebeurt het iOS-werk: wat de browser leverde, omgerekend naar wat de server
      // verwacht. Bij 16 kHz is dit een no-op.
      const pcm = naarPcm16k(ruw, bronRate);

      this.opties.onNiveau?.(Math.min(1, piek * 1.8), poortDicht);
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(pcm.buffer as ArrayBuffer);
    };

    bron.connect(proc);
    // Naar de uitgang met gain 0: een ScriptProcessor draait alleen als hij in de graaf
    // naar de destination loopt, maar we willen onszelf niet terughoren.
    const stil = ctx.createGain();
    stil.gain.value = 0;
    proc.connect(stil);
    stil.connect(ctx.destination);
  }

  /** Audio op volgorde afspelen, zodat er geen gaten of overlap ontstaan. */
  private speel(pcm: Int16Array): void {
    if (this.anam) {
      // Met avatar gaat de audio hun kant op; lokaal afspelen zou hem dubbel laten klinken
      // en bovendien vóór het gezicht uit lopen.
      void this.zorgVoorAnamInvoer().then((invoer) => {
        invoer?.sendAudioChunk(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      });
      return;
    }
    const ctx = this.ctxUit;
    if (!ctx) return;

    // De buffer krijgt de rate van de *audio*, niet die van de context. De browser
    // herbemonstert bij het afspelen; dat is precies waar deze API voor is.
    const buf = ctx.createBuffer(1, pcm.length, this.uitRate);
    const kanaal = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) kanaal[i] = (pcm[i] as number) / 32768;

    const bron = ctx.createBufferSource();
    bron.buffer = buf;
    bron.connect(ctx.destination);
    const nu = ctx.currentTime;
    if (this.volgendeStart < nu) this.volgendeStart = nu + 0.05;
    bron.start(this.volgendeStart);
    this.volgendeStart += buf.duration;
    this.bronnen.push(bron);
    bron.onended = () => {
      this.bronnen = this.bronnen.filter((b) => b !== bron);
    };
  }

  private async zorgVoorAnamInvoer(): Promise<AnamAudioInput | null> {
    if (this.anamInvoer) return this.anamInvoer;
    if (!this.anam) return null;
    this.anamInvoer = await this.anam.createAgentAudioInputStream({
      encoding: 'pcm_s16le',
      sampleRate: this.uitRate,
      channels: 1,
    });
    return this.anamInvoer;
  }

  /** Barge-in: alles wat klaarstaat weggooien, niet uitspelen. */
  private stopGeluid(): void {
    if (this.anam) {
      // Hun eigen onderbreekhaak. Zonder dit praat het gezicht door nadat de server allang
      // is gestopt, en dan lijkt barge-in kapot terwijl hij werkt.
      try {
        this.anam.interruptPersona();
      } catch {
        /* de SDK was al gesloten */
      }
      this.beeindigAnamBeurt();
      return;
    }
    for (const b of this.bronnen) {
      try {
        b.stop();
      } catch {
        /* al gestopt */
      }
    }
    this.bronnen = [];
    this.volgendeStart = 0;
  }

  private beeindigAnamBeurt(): void {
    try {
      this.anamInvoer?.endSequence();
    } catch {
      /* al gesloten */
    }
    this.anamInvoer = null;
  }

  private stuur(bericht: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(bericht));
  }

  /** Idempotent: server en pagina kunnen allebei tegelijk willen stoppen. */
  stop(reden = 'gestopt'): void {
    if (this.gestopt) return;
    this.gestopt = true;

    this.stopGeluid();
    if (this.anam) {
      void Promise.resolve(this.anam.stopStreaming()).catch(() => undefined);
      this.anam = null;
    }
    if (this.proc) this.proc.onaudioprocess = null;
    for (const spoor of this.opties.micStream.getTracks()) spoor.stop();
    try {
      this.ws?.close();
    } catch {
      /* al dicht */
    }
    void this.ctxIn?.close().catch(() => undefined);
    void this.ctxUit?.close().catch(() => undefined);
    for (const op of this.opruimers) op();
    this.opruimers = [];

    this.opties.onGestopt?.(reden);
  }
}
