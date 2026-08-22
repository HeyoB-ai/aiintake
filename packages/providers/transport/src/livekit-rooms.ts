import { createServerToken, type LiveKitCredentials } from './livekit-token';

/**
 * Roombeheer via de LiveKit RoomService (twirp over HTTPS).
 *
 * Alleen wat de intake nodig heeft: een room aanmaken bij sessiestart, hem opruimen bij
 * sessie-einde, en kunnen zien wie er nog in zit. Rooms worden per intakesessie
 * aangemaakt en na afloop verwijderd — een blijvende room is een blijvende
 * toegangsmogelijkheid.
 */

export interface RoomInfo {
  readonly name: string;
  readonly numParticipants: number;
  readonly creationTime: number;
}

export class LiveKitRooms {
  private readonly httpUrl: string;

  constructor(private readonly credentials: LiveKitCredentials) {
    this.httpUrl = credentials.url.replace(/^ws/, 'http').replace(/\/$/, '');
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.httpUrl}/twirp/livekit.RoomService/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${createServerToken(this.credentials)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body ?? {}),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LiveKit ${method}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Maakt de room aan met een lege timeout die past bij een intake.
   *
   * `emptyTimeout` is de kostenknop: blijft een room bestaan nadat iedereen weg is, dan
   * blijft er infrastructuur draaien voor een gesprek dat voorbij is.
   */
  async create(
    name: string,
    options: { emptyTimeoutSeconds?: number; maxParticipants?: number } = {},
  ) {
    return this.call<RoomInfo>('CreateRoom', {
      name,
      empty_timeout: options.emptyTimeoutSeconds ?? 120,
      // cliënt, agent, avatar. Meer hoort er niet in te zitten.
      max_participants: options.maxParticipants ?? 3,
    });
  }

  /**
   * Rooms opvragen, eventueel gefilterd op naam.
   *
   * Let op het gedrag zonder filter: LiveKit Cloud geeft dan alleen rooms terug waar
   * iemand in zit. Een zojuist aangemaakte, nog lege room staat er niet bij — die
   * bestaat wel degelijk, maar je ziet hem alleen door er expliciet naar te vragen.
   * Vandaar `exists()` hieronder: zonder dat onderscheid concludeer je al snel dat
   * CreateRoom niets doet.
   */
  async list(names?: readonly string[]): Promise<RoomInfo[]> {
    const result = await this.call<{ rooms?: RoomInfo[] }>('ListRooms', names ? { names } : {});
    return result.rooms ?? [];
  }

  /** Bestaat deze room? Werkt ook als hij nog leeg is. */
  async exists(name: string): Promise<boolean> {
    const rooms = await this.list([name]);
    return rooms.some((r) => r.name === name);
  }

  async participants(room: string): Promise<{ identity: string }[]> {
    const result = await this.call<{ participants?: { identity: string }[] }>('ListParticipants', {
      room,
    });
    return result.participants ?? [];
  }

  /** Ruimt de room op. Aanroepen bij sessie-einde, niet wachten op de timeout. */
  async delete(room: string): Promise<void> {
    await this.call('DeleteRoom', { room });
  }
}

export function readLiveKitCredentials(
  env: NodeJS.ProcessEnv = process.env,
): LiveKitCredentials | null {
  const url = env['LIVEKIT_URL'];
  const apiKey = env['LIVEKIT_API_KEY'];
  const apiSecret = env['LIVEKIT_API_SECRET'];
  if (!url || !apiKey || !apiSecret) return null;
  if (!/^wss?:\/\/[^/]+/.test(url)) return null;
  return { url, apiKey, apiSecret };
}
