import { AudioFrame, Room, RoomEvent } from '@livekit/rtc-node';
import { initializeLogger, voice } from '@livekit/agents';
import { LiveKitRooms, createAccessToken } from '@intake/provider-transport';

/**
 * Diagnose voor Beyond Presence. Eén korte sessie, geen 12 beurten.
 *
 * Bewaard als reproduceerbaar bewijs bij de supportmelding: het laat zien dat het token,
 * het endpoint, de payload en het audiotransport aan onze kant kloppen, en dat de
 * avatardeelnemer wél verbindt maar nooit een track publiceert.
 *
 * Draaien met: pnpm diag:bey
 */

const livekit = {
  url: process.env['LIVEKIT_URL']!,
  apiKey: process.env['LIVEKIT_API_KEY']!,
  apiSecret: process.env['LIVEKIT_API_SECRET']!,
};

const roomName = `bey-diag-${Date.now()}`;
const AGENT_IDENTITY = 'intake-agent';
const AVATAR_IDENTITY = 'bey-avatar-agent';

const t0 = performance.now();
const log = (...a: unknown[]) =>
  console.log(`[${String(Math.round(performance.now() - t0)).padStart(6)}ms]`, ...a);

const rooms = new LiveKitRooms(livekit);
await rooms.create(roomName, { emptyTimeoutSeconds: 120 });
log('room aangemaakt', roomName);

const agent = createAccessToken(livekit, {
  room: roomName,
  identity: AGENT_IDENTITY,
  role: 'agent',
});
const room = new Room();

room.on(RoomEvent.ParticipantConnected, (p) =>
  log(
    'DEELNEMER ERBIJ',
    p.identity,
    '| kind:',
    (p as { kind?: unknown }).kind,
    '| attrs:',
    JSON.stringify(p.attributes),
  ),
);
room.on(RoomEvent.ParticipantDisconnected, (p) => log('DEELNEMER WEG', p.identity));
room.on(RoomEvent.TrackPublished, (pub, p) =>
  log('TRACK GEPUBLICEERD', p.identity, pub.kind, pub.sid),
);
room.on(RoomEvent.TrackSubscribed, (_t, pub, p) => log('TRACK GEABONNEERD', p.identity, pub.kind));
room.on(RoomEvent.Disconnected, (reason) => log('WIJ LOSGEKOPPELD, reden:', reason));

await room.connect(livekit.url, agent.token, { autoSubscribe: true, dynacast: false });
log('agent verbonden als', room.localParticipant?.identity);

const avatar = createAccessToken(livekit, {
  room: roomName,
  identity: AVATAR_IDENTITY,
  role: 'avatar',
  kind: 'agent',
  attributes: { 'lk.publish_on_behalf': AGENT_IDENTITY },
});

const claims = JSON.parse(Buffer.from(avatar.token.split('.')[1]!, 'base64url').toString('utf8'));
log('avatartoken claims:', JSON.stringify(claims, null, 1));

const response = await fetch('https://api.bey.dev/v1/session', {
  method: 'POST',
  headers: { 'x-api-key': process.env['BEY_API_KEY']!, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    avatar_id: process.env['BEY_DIAG_AVATAR_ID'] ?? process.env['BEY_AVATAR_ID']!,
    livekit_url: livekit.url,
    livekit_token: avatar.token,
  }),
});
const tekst = await response.text();
log('POST /v1/session ->', response.status, tekst.slice(0, 600));

// Beslissende test: publiceert de avatar pas zodra hij audio krijgt?
// Bewust ZONDER waitRemoteTrack, anders wachten wij op video terwijl zij op audio
// zouden wachten en staan we allebei stil.
initializeLogger({ pretty: false, level: 'warn' });
const out = new voice.DataStreamAudioOutput({
  room,
  destinationIdentity: AVATAR_IDENTITY,
  sampleRate: 16_000,
});
log('audio insturen zonder op video te wachten...');
const frame = 320; // 20 ms @ 16 kHz
const pcm = new Int16Array(frame);
try {
  for (let beurt = 0; beurt < 100; beurt += 1) {
    for (let i = 0; i < frame; i += 1) {
      pcm[i] = Math.round(Math.sin((2 * Math.PI * 220 * (beurt * frame + i)) / 16000) * 8000);
    }
    await out.captureFrame(new AudioFrame(pcm, 16_000, 1, frame));
    await new Promise((r) => setTimeout(r, 20));
  }
  out.flush();
  log('2 s audio verstuurd');
} catch (e) {
  log('audio insturen faalde:', (e as Error).message);
}

await new Promise((r) => setTimeout(r, 15_000));
log('einde observatie. Deelnemers nu:', [...room.remoteParticipants.keys()].join(', ') || '(geen)');

await room.disconnect();
await rooms.delete(roomName).catch(() => undefined);
log('opgeruimd');
process.exit(0);
