import { voice } from '@livekit/agents';
import { initializeLogger } from '@livekit/agents';
import * as bey from '@livekit/agents-plugin-bey';
import { Room, RoomEvent, TrackKind } from '@livekit/rtc-node';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

/**
 * Beyond Presence, volgens hun eigen weg.
 *
 * Alles wat hier gebeurt komt uit hun documentatie en hun eigen pakketten:
 *
 *   - het token wordt gemaakt met `livekit-server-sdk` (hun SDK, niet onze minter);
 *   - de room wordt aangemaakt met `RoomServiceClient` (idem);
 *   - de avatar wordt gestart met `bey.AvatarSession` uit `@livekit/agents-plugin-bey`,
 *     de route die hun API-referentie voorschrijft;
 *   - de audio-uitgang wordt door hun plugin zelf gezet, niet door ons.
 *
 * Wat er dus NIET in zit: onze AvatarProvider, onze turn-loop, ons roombeheer, onze
 * tokens. Als dit werkt en ons pad niet, ligt het aan onze integratie. Werkt dit ook
 * niet, dan is het hun kant of het account.
 *
 * Het enige verschil met hun quickstart is dat we geen worker draaien maar de sessie
 * rechtstreeks starten. Hun `AvatarSession.start()` staat dat expliciet toe: hij roept
 * `getJobContext(false)` aan en logt alleen dat je zelf moet opruimen.
 */

const url = process.env.LIVEKIT_URL;
const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const beyKey = process.env.BEY_API_KEY;
const avatarId = process.env.BEY_AVATAR_ID;

for (const [naam, waarde] of Object.entries({
  LIVEKIT_URL: url,
  LIVEKIT_API_KEY: apiKey,
  LIVEKIT_API_SECRET: apiSecret,
  BEY_API_KEY: beyKey,
})) {
  if (!waarde) {
    console.error(`${naam} ontbreekt in ../.env`);
    process.exit(1);
  }
}

initializeLogger({ pretty: true, level: process.env.LK_LOG_LEVEL ?? 'info' });

const roomName = `vendorcheck-bey-${Date.now()}`;
const t0 = performance.now();
const log = (...a) => console.log(`[${String(Math.round(performance.now() - t0)).padStart(6)}ms]`, ...a);

// 1. Room aanmaken met hun eigen server-SDK.
const rooms = new RoomServiceClient(url.replace(/^ws/, 'http'), apiKey, apiSecret);
await rooms.createRoom({ name: roomName, emptyTimeout: 180 });
log('room aangemaakt:', roomName);

// 2. Onze agent verbindt, met een token uit hun SDK.
const agentToken = new AccessToken(apiKey, apiSecret, { identity: 'agent' });
agentToken.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

const room = new Room();
let videoGezien = false;

room.on(RoomEvent.ParticipantConnected, (p) =>
  log('deelnemer erbij:', p.identity, '| kind:', p.kind, '| attrs:', JSON.stringify(p.attributes)),
);
room.on(RoomEvent.ParticipantDisconnected, (p) => log('deelnemer weg:', p.identity));
room.on(RoomEvent.TrackPublished, (pub, p) => {
  log('TRACK GEPUBLICEERD:', p.identity, '| kind:', pub.kind, '| sid:', pub.sid);
  if (pub.kind === TrackKind.KIND_VIDEO) videoGezien = true;
});

await room.connect(url, await agentToken.toJwt(), { autoSubscribe: true, dynacast: false });
log('agent verbonden als', room.localParticipant?.identity);

// 3. Hun AgentSession en hun AvatarSession. Wij zetten hier niets zelf.
const session = new voice.AgentSession();
const avatar = new bey.AvatarSession({
  apiKey: beyKey,
  ...(avatarId ? { avatarId } : {}),
});

try {
  await avatar.start(session, room, {
    livekitUrl: url,
    livekitApiKey: apiKey,
    livekitApiSecret: apiSecret,
  });
  log('avatar.start() teruggekeerd zonder fout');
} catch (error) {
  log('avatar.start() FAALDE:', String(error).slice(0, 400));
}

// 4. Twintig seconden kijken of er een videotrack komt. Dat is het hele oordeel.
await new Promise((r) => setTimeout(r, 20_000));

log('deelnemers nu:', [...room.remoteParticipants.keys()].join(', ') || '(geen)');
console.log(
  videoGezien
    ? '\n  UITKOMST: hun eigen voorbeeld WERKT — er kwam een videotrack.\n' +
        '  Dan ligt het verschil in onze integratie.\n'
    : '\n  UITKOMST: hun eigen voorbeeld werkt OOK NIET — geen videotrack binnen 20 s.\n' +
        '  Dan ligt het aan hun kant of aan het account, niet aan onze integratie.\n',
);

await room.disconnect();
await rooms.deleteRoom(roomName).catch(() => undefined);
process.exit(videoGezien ? 0 : 1);
