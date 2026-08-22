import { createHmac } from 'node:crypto';

/**
 * LiveKit access tokens.
 *
 * Bewust zonder SDK: een LiveKit-token is een HS256-JWT met één claimobject, en
 * `node:crypto` doet de HMAC. De server-SDK zou een dependency toevoegen die niets
 * anders doet dan dit, en tokens minten is precies het soort code waarvan je wilt
 * kunnen zien wat er in de claim staat.
 *
 * Wie welk token krijgt, is een autorisatiebeslissing en geen configuratie:
 *
 *   cliënt  — mag publiceren (microfoon) en abonneren (avatarvideo), in één room
 *   agent   — mag abonneren op de cliëntaudio; publiceert zelf niets
 *   avatar  — mag publiceren; de vendor rendert het gezicht in dezelfde room
 *
 * De TTL volgt de sessie. Een token dat langer leeft dan het gesprek is hetzelfde
 * probleem als bij het agent-sessietoken (ADR-0007), alleen dan voor de room.
 */

export interface LiveKitCredentials {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

export type ParticipantRole = 'client' | 'agent' | 'avatar';

export interface TokenRequest {
  readonly room: string;
  readonly identity: string;
  readonly role: ParticipantRole;
  readonly ttlSeconds?: number;
  /** Vrije tekst die aan de deelnemer hangt; nooit persoonsgegevens. */
  readonly metadata?: string;
}

interface VideoGrant {
  room: string;
  roomJoin: true;
  canPublish: boolean;
  canSubscribe: boolean;
  canPublishData: boolean;
  /** De cliënt publiceert alleen audio; camera blijft lokaal. Zie ADR-0004. */
  canPublishSources?: string[];
}

function grantFor(role: ParticipantRole, room: string): VideoGrant {
  switch (role) {
    case 'client':
      return {
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        // Alleen de microfoon. De cliëntcamera wordt standaard niet gepubliceerd, en
        // dat hoort niet alleen in de client-code te staan maar ook in het token —
        // anders is het een afspraak in plaats van een grens.
        canPublishSources: ['microphone'],
        canPublishData: true,
      };
    case 'agent':
      // De worker luistert. De avatarvendor publiceert het gezicht, wij niet.
      return { room, roomJoin: true, canPublish: false, canSubscribe: true, canPublishData: true };
    case 'avatar':
      return { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false };
  }
}

export function createAccessToken(
  credentials: LiveKitCredentials,
  request: TokenRequest,
): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = request.ttlSeconds ?? 30 * 60;
  const exp = now + ttl;

  const payload: Record<string, unknown> = {
    iss: credentials.apiKey,
    sub: request.identity,
    // `nbf` iets in het verleden: klokverschil tussen onze server en LiveKit mag geen
    // token ongeldig maken dat net is uitgegeven.
    nbf: now - 10,
    iat: now,
    exp,
    jti: request.identity,
    video: grantFor(request.role, request.room),
  };
  if (request.metadata) payload['metadata'] = request.metadata;

  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', credentials.apiSecret)
    .update(`${header}.${body}`)
    .digest();

  return { token: `${header}.${body}.${b64urlBytes(signature)}`, expiresAt: new Date(exp * 1000) };
}

/** Servertoken voor de RoomService-API. Geen roomJoin, wel roombeheer. */
export function createServerToken(credentials: LiveKitCredentials, ttlSeconds = 60): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({
      iss: credentials.apiKey,
      sub: credentials.apiKey,
      nbf: now - 10,
      iat: now,
      exp: now + ttlSeconds,
      video: { roomCreate: true, roomList: true, roomAdmin: true },
    }),
  );
  const signature = createHmac('sha256', credentials.apiSecret)
    .update(`${header}.${body}`)
    .digest();
  return `${header}.${body}.${b64urlBytes(signature)}`;
}

const b64url = (value: string) => b64urlBytes(Buffer.from(value, 'utf8'));
const b64urlBytes = (bytes: Buffer) =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
