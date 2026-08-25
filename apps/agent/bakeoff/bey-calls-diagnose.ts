import { Room, RoomEvent, TrackKind } from '@livekit/rtc-node';
import { createAccessToken, LiveKitRooms } from '@intake/provider-transport';

/**
 * Twee endpoints van Beyond Presence naast elkaar — en wat eruit kwam.
 *
 * ## De aanleiding
 *
 * Hun site noemt `POST /v1/calls` met `avatar_id`, `livekit_url`, `livekit_token` en
 * `language`, terwijl wij op `POST /v1/session` draaien. Het vermoeden was dat wij een
 * verouderd endpoint gebruiken.
 *
 * ## Wat er gemeten is
 *
 * **1. Wij stuurden `avatar_id` allang.** Het verschil met de gedocumenteerde payload was
 * niet dat veld, maar het pad en `language`.
 *
 * **2. `/v1/calls` vraagt geen `avatar_id` maar een `agent_id`** (HTTP 422). Een agent
 * maak je met `POST /v1/agent`, en die vraagt `name`, `avatar_id` én `system_prompt`. Dat
 * is hun eigen gespreksbrein — het equivalent van een Anam-persona, met alles wat wij
 * juist niet willen: hun LLM, hun STT, hun TTS.
 *
 * **3. En die route is afgesloten.** Met een aangemaakte agent geeft `/v1/calls`:
 *
 *     HTTP 403 — "Calls can be started at https://bey.chat/<id>. Programmatic call
 *     creation via API is only available from Growth Plan onwards."
 *
 * Programmatisch bellen zit achter een duurder abonnement. Het is dus geen payloadkwestie
 * en ook geen verouderd endpoint: die weg staat voor dit account gewoon dicht.
 *
 * **4. `language` is een enum met `nl` erin** — `'ar', 'ar-SA', 'bn', … 'nl', 'en', …`.
 * Maar het veld hoort bij de **agent**, niet bij de sessie: `/v1/session` accepteert het
 * niet en heeft het ook niet nodig. Het configureert hún spraakketen. De vergelijking met
 * Anam gaat hier dus niet op — daar bepaalde de persona het gezicht én de stem omdat hun
 * engine meepraatte; hier praat er bij passthrough niets van hen mee, en is er geen taal
 * om verkeerd te zetten.
 *
 * **5. `/v1/session` accepteert zowel `livekit_url`/`livekit_token` als `url`/`token`.**
 * Beide leveren met een ongeldig token dezelfde HTTP 400, dus het zijn aliassen en niet
 * het verschil.
 *
 * ## Wat er blijft staan
 *
 * `/v1/session` geeft 201, de sessie verschijnt in `GET /v1/session`, de avatar-deelnemer
 * komt de room binnen — en publiceert nooit een videotrack. De status blijft `to_start`.
 * Tien sessies op het account staan zo. Dat is hetzelfde beeld als hun eigen plugin buiten
 * onze codebase gaf, en het is precies wat er aan support is gevraagd.
 *
 * ## Kosten
 *
 * Elke geslaagde poging start een sessie aan hun kant.
 *
 * Draaien met: pnpm diag:bey-calls
 */
const API = 'https://api.bey.dev';
const KIJKDUUR_MS = 20_000;
/** Zelfde attribuut als in de adapter: de avatar publiceert namens de agent. */
const PUBLISH_ON_BEHALF = 'lk.publish_on_behalf';
const AGENT_IDENTITY = 'agent';

function nodig(naam: string): string {
  const waarde = process.env[naam];
  if (!waarde) throw new Error(`${naam} ontbreekt in .env`);
  return waarde;
}

const apiKey = nodig('BEY_API_KEY');
const livekit = {
  url: nodig('LIVEKIT_URL'),
  apiKey: nodig('LIVEKIT_API_KEY'),
  apiSecret: nodig('LIVEKIT_API_SECRET'),
};
const avatarId = process.env['BEY_AVATAR_ID'];

interface Poging {
  readonly naam: string;
  readonly pad: string;
  readonly extra: Record<string, unknown>;
}

const pogingen: Poging[] = [
  { naam: '/v1/session (wat wij nu doen)', pad: '/v1/session', extra: {} },
  // Blijft staan als bewijsstuk: hij hoort te falen op `agent_id`, en zodra hij dát niet
  // meer doet, is hun API veranderd en verdient deze route een nieuwe blik.
  { naam: '/v1/calls + language', pad: '/v1/calls', extra: { language: taal() } },
];

/**
 * De taalwaarde.
 *
 * Instelbaar omdat het de kern van de vraag raakt: bij passthrough leveren wíj de audio,
 * dus taal zou niet uit moeten maken. Bij Anam dachten we dat ook, en daar bleek een
 * Spaanse persona het gezicht én de stem te bepalen. Wat hun documentatie hier accepteert
 * is niet vastgesteld; deze proef stuurt wat je meegeeft en rapporteert wat eruit komt.
 */
function taal(): string {
  return process.env['BEY_LANGUAGE'] ?? 'nl';
}

async function probeer(poging: Poging): Promise<boolean> {
  const roomNaam = `beycalls-${poging.pad.replace(/\W/g, '')}-${process.pid}-${pogingen.indexOf(poging)}`;

  // Dezelfde room- en tokenopzet als de adapter. Zou die hier afwijken, dan meet deze
  // proef het endpoint én onze bedrading tegelijk, en zegt een verschil niets.
  await new LiveKitRooms(livekit).create(roomNaam, { emptyTimeoutSeconds: 120 });

  const agentToken = createAccessToken(livekit, {
    room: roomNaam,
    identity: AGENT_IDENTITY,
    role: 'agent',
  }).token;
  const avatarToken = createAccessToken(livekit, {
    room: roomNaam,
    identity: 'avatar',
    role: 'avatar',
    kind: 'agent',
    attributes: { [PUBLISH_ON_BEHALF]: AGENT_IDENTITY },
  }).token;

  const room = new Room();
  let videoGezien = false;
  const deelnemers: string[] = [];
  room.on(RoomEvent.ParticipantConnected, (p) => deelnemers.push(p.identity ?? '?'));
  room.on(RoomEvent.TrackPublished, (pub) => {
    if (pub.kind === TrackKind.KIND_VIDEO) videoGezien = true;
  });
  await room.connect(livekit.url, agentToken, { autoSubscribe: true, dynacast: false });

  const body = {
    avatar_id: avatarId,
    livekit_url: livekit.url,
    livekit_token: avatarToken,
    ...poging.extra,
  };

  const res = await fetch(`${API}${poging.pad}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const antwoord = await res.text();
  console.log(`\n  ${poging.naam}`);
  console.log(`    velden: ${Object.keys(body).join(', ')}`);
  console.log(`    HTTP ${res.status} — ${antwoord.slice(0, 200)}`);

  if (res.ok) {
    await new Promise((r) => setTimeout(r, KIJKDUUR_MS));
    console.log(
      `    deelnemers: ${deelnemers.join(', ') || '(geen)'} · videotrack: ${videoGezien ? 'JA' : 'nee'}`,
    );
  }

  await room.disconnect();
  return videoGezien;
}

console.log('\n  Beyond Presence — komt er een videotrack?');
console.log(`  avatar ${avatarId ?? '(standaard van het account)'} · taal ${taal()}`);

const uitslagen: { naam: string; video: boolean }[] = [];
for (const poging of pogingen) {
  try {
    uitslagen.push({ naam: poging.naam, video: await probeer(poging) });
  } catch (error) {
    console.log(
      `    MISLUKT: ${String(error)
        .replace(/^Error: /, '')
        .slice(0, 200)}`,
    );
    uitslagen.push({ naam: poging.naam, video: false });
  }
}

console.log('');
for (const u of uitslagen)
  console.log(`  ${u.naam.padEnd(32)} ${u.video ? 'VIDEO' : 'geen video'}`);
const werkt = uitslagen.filter((u) => u.video);
console.log(
  werkt.length === 0
    ? '\n  Geen van beide endpoints levert beeld. Dan ligt het niet aan de payload.\n'
    : `\n  Beeld via: ${werkt.map((u) => u.naam).join(', ')}\n`,
);
process.exit(werkt.length > 0 ? 0 : 1);
