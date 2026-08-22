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
  /**
   * Deelnemersoort. LiveKit kent `standard` (impliciet) en `agent`.
   *
   * Een avatarworker moet `agent` zijn, anders weigert de server de combinatie met
   * `lk.publish_on_behalf` hieronder.
   */
  readonly kind?: 'agent';
  /**
   * Deelnemerattributen, plat in de claim.
   *
   * De enige die wij zetten is `lk.publish_on_behalf`: die vertelt LiveKit dat de
   * tracks van deze deelnemer namens een ándere deelnemer worden gepubliceerd. Zonder
   * dat attribuut verschijnt de avatar als losse deelnemer in de room in plaats van als
   * het gezicht van de assistent.
   */
  readonly attributes?: Readonly<Record<string, string>>;
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
      // De worker publiceert de stem van de assistent en abonneert op de cliëntaudio.
      //
      // Dat hij publiceert is geen ontwerpkeuze maar een gevolg van hoe audio-to-video
      // werkt: de avatarvendor rendert een gezicht op een audiotrack in de room. Zonder
      // die track heeft hij niets om lippen op te synchroniseren. De eerdere aanname —
      // "de vendor publiceert, wij niet" — klopte alleen voor een modus waarin de vendor
      // ook de TTS doet, en juist die modus willen we niet (ADR-0001: de stem blijft in
      // eigen hand).
      //
      // Alleen `microphone`: de worker heeft geen reden om video te publiceren.
      return {
        room,
        roomJoin: true,
        canPublish: true,
        canPublishSources: ['microphone'],
        canSubscribe: true,
        canPublishData: true,
      };
    case 'avatar':
      // `canPublishData: true`, en dat is geen ruimhartigheid maar een vereiste.
      //
      // De avatarworker meldt via een LiveKit-RPC (`lk.playback_finished`) terug hoeveel
      // audio hij daadwerkelijk heeft afgespeeld. Die RPC loopt over het datakanaal.
      // Stond dit op false, dan bleef het terugmeldpad stil en zou `interrupt()` een
      // spokenMs teruggeven die op niets is gebaseerd — precies het stille dataverlies
      // waar risico 2 over gaat, maar dan aan de assistentkant van het transcript.
      return { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true };
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
  // Plat in de claim, niet genest onder `video`: zo leest de LiveKit-server ze, en zo
  // zet de officiële server-SDK ze ook neer (`claimsToJwtPayload` spreidt het
  // grantobject uit over de payload).
  if (request.kind) payload['kind'] = request.kind;
  if (request.attributes) payload['attributes'] = request.attributes;

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
