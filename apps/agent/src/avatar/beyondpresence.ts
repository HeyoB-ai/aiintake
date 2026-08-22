import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoStream,
} from '@livekit/rtc-node';
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
 * Het model: wij publiceren een audiotrack in een LiveKit-room, hun worker abonneert
 * zich daarop en publiceert een videotrack met een gezicht dat die audio meebeweegt.
 * Wij houden dus STT, TTS en dus de Nederlandse stemkwaliteit in eigen hand, en de
 * vendor doet alleen het gezicht — precies wat ADR-0001 vereist.
 *
 * Deze adapter woont in apps/agent en niet in packages/providers/avatar, om één reden:
 * hij hangt aan `@livekit/rtc-node`, een pakket met native binaries. De avatarpackage
 * blijft daarmee vrij van platformafhankelijkheden en dus importeerbaar in tests en in
 * de browser-build.
 */

const API = 'https://api.bey.dev/v1';

export interface BeyondPresenceOptions {
  readonly apiKey: string;
  readonly avatarId: string;
  readonly livekit: LiveKitCredentials;
  readonly sampleRate?: number;
}

class BeyondPresenceSession implements AvatarSession {
  private readonly handlers = new Map<string, Function[]>();
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private sessionId: string | null = null;
  private videoTrackHandle: TrackHandle | null = null;

  /** Alles wat we hebben aangeleverd. Bovengrens van wat gehoord kan zijn. */
  private pushedMs = 0;
  private firstFrameSeen = false;

  constructor(
    private readonly options: Required<BeyondPresenceOptions>,
    private readonly roomName: string,
  ) {}

  async start(): Promise<void> {
    const { livekit } = this.options;

    const rooms = new LiveKitRooms(livekit);
    await rooms.create(this.roomName, { emptyTimeoutSeconds: 120 });

    // Wij sluiten aan als publisher van de assistentstem.
    const agent = createAccessToken(livekit, {
      room: this.roomName,
      identity: 'intake-agent',
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

    const source = new AudioSource(this.options.sampleRate, 1);
    this.source = source;
    const track = LocalAudioTrack.createAudioTrack('assistant', source);
    const publishOptions = new TrackPublishOptions();
    publishOptions.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant?.publishTrack(track, publishOptions);

    // Pas nu de vendor uitnodigen: staat onze audiotrack er nog niet, dan heeft zijn
    // worker bij binnenkomst niets om op te synchroniseren.
    const avatar = createAccessToken(livekit, {
      room: this.roomName,
      identity: 'bey-avatar',
      role: 'avatar',
    });

    const response = await fetch(`${API}/sessions`, {
      method: 'POST',
      headers: { 'x-api-key': this.options.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transport: 'livekit',
        avatar_id: this.options.avatarId,
        url: this.options.livekit.url,
        token: avatar.token,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Beyond Presence: HTTP ${response.status} — ${detail.slice(0, 200)}`);
    }

    const body = (await response.json()) as { id?: string };
    this.sessionId = body.id ?? null;
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
    if (!this.source) return;
    const frame = new AudioFrame(pcm, this.options.sampleRate, 1, pcm.length);
    this.pushedMs += (pcm.length / this.options.sampleRate) * 1000;
    await this.source.captureFrame(frame);
  }

  /**
   * Onderbreken: wachtrij leeg, en teruggeven hoeveel er daadwerkelijk klonk.
   *
   * `queuedDuration` is wat er nog in de buffer staat en dus níét gehoord is. Het
   * verschil met wat we hebben aangeleverd, is de uitgesproken tijd. Dat is dezelfde
   * boekhouding als bij de null-provider, maar dan met de echte afspeelbuffer in plaats
   * van een gesimuleerde klok.
   */
  async interrupt(): Promise<{ spokenMs: number }> {
    if (!this.source) return { spokenMs: 0 };

    const queuedMs = toMs(this.source.queuedDuration);
    const spokenMs = Math.max(0, Math.round(this.pushedMs - queuedMs));

    this.source.clearQueue();
    this.pushedMs = 0;
    this.firstFrameSeen = false;
    this.emit('speaking_end');

    return { spokenMs };
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
    this.source?.close();
    await this.room?.disconnect();
    this.room = null;
    this.source = null;

    // De room opruimen in plaats van wachten op de timeout: elke seconde dat hij
    // bestaat, is een seconde waarin de vendor kan doorrenderen.
    await new LiveKitRooms(this.options.livekit).delete(this.roomName).catch(() => undefined);
  }
}

/** queuedDuration komt als seconden of als nanoseconden-bigint; beide afhandelen. */
function toMs(value: number | bigint): number {
  if (typeof value === 'bigint') return Number(value) / 1_000_000;
  return value * 1000;
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
      sampleRate: options.sampleRate ?? 16_000,
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
