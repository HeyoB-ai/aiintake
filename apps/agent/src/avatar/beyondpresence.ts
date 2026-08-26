import { initializeLogger, voice } from '@livekit/agents';
import { AudioFrame, Room, RoomEvent, TrackKind, VideoStream } from '@livekit/rtc-node';
import type {
  AvatarCapabilities,
  AvatarEvents,
  AvatarProvider,
  AvatarSession,
  AvatarSessionOptions,
  TrackHandle,
} from '@intake/provider-avatar';
import {
  LiveKitRooms,
  createAccessToken,
  type LiveKitCredentials,
} from '@intake/provider-transport';

/**
 * Beyond Presence in audio-to-video-modus.
 *
 * **Deze adapter is herbouwd.** De eerste versie publiceerde een audiotrack in de room en
 * hoopte dat de avatarworker zich daarop zou abonneren. Dat is niet hoe bey werkt, en de
 * API-referentie zegt het zelf: gebruik de LiveKit-plugin, niet het endpoint direct. Drie
 * dingen klopten niet, alle drie aan onze kant:
 *
 *   1. de audio gaat over een LiveKit **DataStream** naar de avatardeelnemer, niet over
 *      een gepubliceerde audiotrack;
 *   2. het avatartoken heeft `kind: "agent"` plus het attribuut `lk.publish_on_behalf`
 *      met onze eigen identity nodig — anders komt de avatar als losse deelnemer binnen
 *      in plaats van als het gezicht van de assistent;
 *   3. het endpoint is `/v1/session` (enkelvoud) met `livekit_url` en `livekit_token`.
 *
 * Het dataprotocol zelf bouwen we daarom niet na. Dat is precies de afhankelijkheid die
 * je niet wilt: een vendor mag zijn framing wijzigen, en dan hoort dat een `pnpm update`
 * te zijn en geen debugsessie.
 *
 * ## Waar de grens ligt met @livekit/agents
 *
 * Van die library gebruiken we uitsluitend `voice.DataStreamAudioOutput`: een audiosink
 * met `captureFrame`, `flush` en `clearBuffer`. Dat is transport.
 *
 * Wat we bewust *niet* gebruiken is `voice.AgentSession` — de klasse waar hun eigen
 * bey-plugin op leunt. Die brengt een compleet gespreksmodel mee (agent, chatcontext,
 * turn detection, hun STT/LLM/TTS-knopen). Zou onze turn-loop daarop gaan draaien, dan
 * verhuist de intake-intelligentie van `packages/intake-engine` naar een vendor-framework
 * en werkt de chat-fallback niet langer identiek aan de videomodus. De prijs voor die
 * knip is deze adapter: wij regelen zelf de room, het token en het levenscyclusbeheer.
 * Dat is ~80 regels, en ze staan hier, achter `AvatarProvider`.
 *
 * De boundary-regel dwingt dat af: `@livekit/agents` staat in VENDOR_SDKS en is een
 * dependency van `apps/agent`, niet van een package. Een import in intake-engine faalt
 * de build.
 *
 * Deze adapter woont in apps/agent en niet in packages/providers/avatar omdat hij aan
 * `@livekit/rtc-node` hangt, een pakket met native binaries.
 */

const API = 'https://api.bey.dev';

/** Zoals hun plugin de deelnemer noemt; de vendor verwacht deze identity. */
const AVATAR_IDENTITY = 'bey-avatar-agent';
const AGENT_IDENTITY = 'intake-agent';
const PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';

/** Waar @livekit/agents zijn logger parkeert: op globalThis, achter een Symbol.for. */
const LOGGER_KEY = Symbol.for('@livekit/agents:logger');

/**
 * Zorgt dat de logger van @livekit/agents bestaat.
 *
 * `voice.DataStreamAudioOutput` roept in zijn constructor `log()` aan, en die gooit als
 * er niets is geïnitialiseerd. Normaal doet de worker-bootstrap van hun framework dat —
 * en dat is precies het stuk dat wij overslaan door `voice.AgentSession` niet over te
 * nemen (ADR-0011). Dit is dus geen bug maar de rekening van die keuze.
 *
 * Idempotent, en bewust via dezelfde globale sleutel als zijzelf gebruiken: draait er
 * later alsnog een echte agent-worker in dit proces, dan overschrijven wij diens
 * logconfiguratie niet.
 */
function zorgVoorLogger(): void {
  if ((globalThis as Record<symbol, unknown>)[LOGGER_KEY]) return;
  initializeLogger({
    pretty: false,
    // Niet 'silent': een waarschuwing dat de avatardeelnemer wegblijft of dat een
    // terugmelding niet aankomt, wil je zien. Debugruis wil je niet.
    level: process.env['LIVEKIT_AGENTS_LOG_LEVEL'] ?? 'warn',
  });
}

export interface BeyondPresenceOptions {
  readonly apiKey: string;
  readonly avatarId: string;
  readonly livekit: LiveKitCredentials;
  readonly sampleRate?: number;
}

class BeyondPresenceSession implements AvatarSession {
  private readonly handlers = new Map<string, Function[]>();
  private room: Room | null = null;
  private output: voice.DataStreamAudioOutput | null = null;
  private videoTrackHandle: TrackHandle | null = null;

  /** Alles wat we hebben aangeleverd sinds de laatste flush of interrupt. */
  private pushedMs = 0;
  private firstFrameSeen = false;

  constructor(
    private readonly options: Required<BeyondPresenceOptions>,
    private readonly roomName: string,
  ) {}

  async start(): Promise<void> {
    zorgVoorLogger();
    const { livekit } = this.options;

    const rooms = new LiveKitRooms(livekit);
    await rooms.create(this.roomName, { emptyTimeoutSeconds: 120 });

    const agent = createAccessToken(livekit, {
      room: this.roomName,
      identity: AGENT_IDENTITY,
      role: 'agent',
    });

    const room = new Room();
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== TrackKind.KIND_VIDEO || this.firstFrameSeen) return;
      this.videoTrackHandle = { kind: 'video', id: track.sid ?? 'bey' };
      void this.watchFirstFrame(track);
    });

    await room.connect(livekit.url, agent.token, { autoSubscribe: true, dynacast: false });

    // Het avatartoken. De twee claims die het verschil maken staan hieronder; zonder
    // beide accepteert LiveKit de deelnemer wel, maar niet als publisher namens ons.
    const avatar = createAccessToken(livekit, {
      room: this.roomName,
      identity: AVATAR_IDENTITY,
      role: 'avatar',
      kind: 'agent',
      attributes: { [PUBLISH_ON_BEHALF]: AGENT_IDENTITY },
    });

    const response = await fetch(`${API}/v1/session`, {
      method: 'POST',
      headers: { 'x-api-key': this.options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        avatar_id: this.options.avatarId,
        livekit_url: livekit.url,
        livekit_token: avatar.token,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Beyond Presence: HTTP ${response.status} — ${detail.slice(0, 200)}`);
    }

    // Pas nu de sink opzetten. Hij wacht zelf op de avatardeelnemer én op diens
    // videotrack voordat het eerste frame wordt weggeschreven, dus audio die we
    // aanleveren voordat de vendor klaarstaat gaat niet verloren.
    this.output = new voice.DataStreamAudioOutput({
      room,
      destinationIdentity: AVATAR_IDENTITY,
      sampleRate: this.options.sampleRate,
      waitRemoteTrack: TrackKind.KIND_VIDEO,
    });
  }

  /** Het eerste videoframe sluit de latencymeting van de beurt af. */
  private async watchFirstFrame(track: { sid?: string }): Promise<void> {
    try {
      // Cast omdat de DOM-lib (nodig voor de bakeoff-pagina) de asyncIterator-signatuur
      // van rtc-node's VideoStream overschaduwt. Runtime is hij wel itereerbaar.
      const stream = new VideoStream(track as never) as unknown as AsyncIterable<unknown>;
      for await (const _frame of stream) {
        if (!this.firstFrameSeen) {
          this.firstFrameSeen = true;
          this.emit('first_frame');
        }
        break;
      }
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error('videostream faalde'));
    }
  }

  async pushAudio(pcm: Int16Array, _seq: number): Promise<void> {
    if (!this.output) return;
    const frame = new AudioFrame(pcm, this.options.sampleRate, 1, pcm.length);
    this.pushedMs += (pcm.length / this.options.sampleRate) * 1000;
    await this.output.captureFrame(frame);
  }

  /**
   * Einde van de assistent-beurt: sluit het audiosegment af.
   *
   * Zonder deze aanroep blijft de DataStream-writer open, blijft de vendor denken dat er
   * nog audio komt, en meldt hij nooit dat het afspelen klaar is.
   */
  endTurn(): void {
    this.output?.flush();
    this.pushedMs = 0;
  }

  /**
   * Onderbreken, en teruggeven hoeveel er daadwerkelijk klonk.
   *
   * `clearBuffer()` stuurt een RPC naar de avatarworker; die antwoordt met
   * `playbackPosition` — hoeveel seconden hij écht heeft afgespeeld. Dat is een getal
   * van de kant die het weet, en niet onze eigen schatting op basis van wat we hebben
   * verstuurd.
   *
   * Het terugvalpad staat er omdat dit antwoord over het datakanaal moet komen en dus
   * kan uitblijven. Blijft het uit, dan gebruiken we de bovengrens (alles wat we hebben
   * aangeleverd) en melden we dat als fout. Die keuze kapt de assistent-beurt in het
   * transcript te laat af in plaats van te vroeg: liever iets in het transcript dat de
   * cliënt misschien niet hoorde, dan stilzwijgend tekst weggooien die hij wel hoorde.
   */
  async interrupt(): Promise<{ spokenMs: number }> {
    const output = this.output;
    if (!output) return { spokenMs: 0 };

    const bovengrens = Math.round(this.pushedMs);
    output.clearBuffer();

    let spokenMs = bovengrens;
    try {
      const event = await withTimeout(output.waitForPlayout(), 1_000);
      spokenMs = Math.round(event.playbackPosition * 1000);
    } catch {
      this.emit(
        'error',
        new Error(
          'Beyond Presence meldde niet terug hoeveel audio is afgespeeld; ' +
            `teruggevallen op de bovengrens van ${bovengrens} ms.`,
        ),
      );
    }

    this.pushedMs = 0;
    this.firstFrameSeen = false;
    this.emit('speaking_end');

    return { spokenMs: Math.max(0, Math.min(spokenMs, bovengrens)) };
  }

  async videoTrack(): Promise<TrackHandle> {
    return this.videoTrackHandle ?? { kind: 'video', id: 'pending' };
  }

  on<E extends keyof AvatarEvents>(event: E, handler: AvatarEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Function);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async disconnect(): Promise<void> {
    this.output?.flush();
    this.output = null;
    await this.room?.disconnect();
    this.room = null;

    // De room opruimen in plaats van wachten op de timeout: elke seconde dat hij
    // bestaat, is een seconde waarin de vendor kan doorrenderen.
    await new LiveKitRooms(this.options.livekit).delete(this.roomName).catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export class BeyondPresenceAvatarProvider implements AvatarProvider {
  readonly id = 'beyondpresence' as const;

  readonly capabilities: AvatarCapabilities = {
    audioPassthrough: true,
    textDriven: false,
    interrupt: true,
    idleMotion: true,
  };

  private readonly options: Required<BeyondPresenceOptions>;

  constructor(options: BeyondPresenceOptions) {
    this.options = {
      sampleRate: options.sampleRate,
      ...options,
    } as Required<BeyondPresenceOptions>;
  }

  async createSession(options: AvatarSessionOptions): Promise<AvatarSession> {
    const roomName = options.roomName ?? `intake-${Date.now()}`;
    const session = new BeyondPresenceSession(this.options, roomName);
    await session.start();
    return session;
  }
}
