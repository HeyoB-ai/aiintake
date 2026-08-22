/**
 * Reproductie voor Beyond Presence support.
 *
 * Doet exact wat hun audio-to-video-documentatie voorschrijft:
 *   1. LiveKit-room aanmaken
 *   2. als agent aansluiten en een audiotrack publiceren
 *   3. POST /v1/sessions met transport=livekit, avatar_id, url en een roomtoken
 *
 * Waargenomen gedrag: de sessie wordt aangemaakt (201), hun worker verschijnt kort in
 * de room, verdwijnt weer, komt later terug, en publiceert nooit een videotrack. De
 * sessiestatus blijft `to_start` en gaat niet naar `ongoing`.
 *
 * Draaien vanuit apps/agent:  node scripts/diagnose-bey.mjs
 */
import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import {
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';

if (existsSync('../../../.env')) process.loadEnvFile('../../../.env');

const url = process.env.LIVEKIT_URL;
const key = process.env.LIVEKIT_API_KEY;
const secret = process.env.LIVEKIT_API_SECRET;
const room = `diag-${Math.random().toString(36).slice(2, 8)}`;

const b64 = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function token(identity, grant) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(
    JSON.stringify({
      iss: key,
      sub: identity,
      nbf: now - 10,
      iat: now,
      exp: now + 1800,
      video: grant,
    }),
  );
  return `${h}.${p}.${b64(createHmac('sha256', secret).update(`${h}.${p}`).digest())}`;
}
const server = token(key, { roomCreate: true, roomList: true, roomAdmin: true });
const api = async (m, body) => {
  const r = await fetch(`${url.replace(/^ws/, 'http')}/twirp/livekit.RoomService/${m}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.ok ? r.json() : { error: r.status, text: await r.text() };
};

await api('CreateRoom', { name: room, empty_timeout: 300 });

const lk = new Room();
lk.on(RoomEvent.ParticipantConnected, (p) => console.log('  + deelnemer:', p.identity));
lk.on(RoomEvent.TrackPublished, (pub, p) =>
  console.log('  + track gepubliceerd:', p.identity, 'kind', pub.kind, 'source', pub.source),
);
lk.on(RoomEvent.TrackSubscribed, (t, pub, p) =>
  console.log('  + geabonneerd:', p.identity, 'kind', t.kind),
);
lk.on(RoomEvent.ParticipantDisconnected, (p) => console.log('  - deelnemer weg:', p.identity));
lk.on(RoomEvent.Disconnected, (r) => console.log('  ! room disconnected:', r));

await lk.connect(
  url,
  token('diag-agent', {
    room,
    roomJoin: true,
    canPublish: true,
    canPublishSources: ['microphone'],
    canSubscribe: true,
  }),
  { autoSubscribe: true },
);
console.log('agent verbonden');

const source = new AudioSource(16000, 1);
const opts = new TrackPublishOptions();
opts.source = TrackSource.SOURCE_MICROPHONE;
await lk.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('assistant', source), opts);
console.log('audiotrack gepubliceerd');

const avatarToken = token('bey-avatar', {
  room,
  roomJoin: true,
  canPublish: true,
  canSubscribe: true,
  canPublishData: true,
  canUpdateOwnMetadata: true,
});
const res = await fetch('https://api.bey.dev/v1/sessions', {
  method: 'POST',
  headers: { 'x-api-key': process.env.BEY_API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    transport: 'livekit',
    avatar_id: process.env.BEY_AVATAR_ID,
    url,
    token: avatarToken,
  }),
});
const body = await res.json().catch(() => null);
console.log('sessie aanmaken:', res.status, JSON.stringify(body).slice(0, 300));

for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const ps = await api('ListParticipants', { room });
  const names = (ps.participants ?? []).map(
    (p) => `${p.identity}(${(p.tracks ?? []).map((t) => t.type).join('/')})`,
  );
  let status = '';
  if (body?.id) {
    const s = await fetch(`https://api.bey.dev/v1/sessions/${body.id}`, {
      headers: { 'x-api-key': process.env.BEY_API_KEY },
    });
    const sb = await s.json().catch(() => ({}));
    status = ` | sessie: ${JSON.stringify(sb).slice(0, 160)}`;
  }
  console.log(`  t+${(i + 1) * 3}s deelnemers: ${names.join(', ') || '(geen)'}${status}`);
}

await lk.disconnect();
await api('DeleteRoom', { room });
process.exit(0);
