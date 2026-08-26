import { afterEach, describe, expect, it } from 'vitest';
import { readLiveKitCredentials } from '@intake/provider-transport';
import type { AvatarSession } from '@intake/provider-avatar';
import { BeyondPresenceAvatarProvider } from './beyondpresence';

/**
 * De bakeoff: hoe lang duurt het tussen "wij leveren audio" en "het gezicht beweegt"?
 *
 * Dat is de enige stap uit de latencybegroting die je niet kunt schatten en die de
 * vendorclaims niet meten. Beyond Presence claimt <100 ms streaming inference en
 * ≤250 ms speech-to-video; Anam claimt 180 ms responstijd. Geen van die getallen is de
 * tijd tussen het aanleveren van PCM en het eerste bewegende frame in onze room, en
 * juist dat is wat de cliënt ervaart.
 *
 * Deze test start een echte sessie en kost dus avatarminuten. Hij draait daarom alleen
 * via `pnpm test:bakeoff`, nooit in `pnpm test`, en nooit in CI — de meting moet
 * bovendien vanaf een machine in Nederland komen, niet vanuit een runner in een
 * willekeurige regio.
 */

const credentials = readLiveKitCredentials();
const heeftBey = Boolean(process.env['BEY_API_KEY'] && process.env['BEY_AVATAR_ID']);
const describeLive = credentials && heeftBey ? describe : describe.skip;

if (!credentials || !heeftBey) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[bakeoff] OVERGESLAGEN — ' +
      (!credentials ? 'LiveKit-credentials ontbreken. ' : '') +
      (!heeftBey ? 'BEY_API_KEY of BEY_AVATAR_ID ontbreekt.' : '') +
      '\n',
  );
}

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;

/** Een seconde stille PCM, in blokken van 20 ms — genoeg om het gezicht te laten starten. */
function stilte(ms: number): Int16Array[] {
  const perFrame = (SAMPLE_RATE / 1000) * FRAME_MS;
  return Array.from({ length: Math.ceil(ms / FRAME_MS) }, () => new Int16Array(perFrame));
}

describeLive('bakeoff — Beyond Presence', () => {
  let session: AvatarSession | null = null;

  afterEach(async () => {
    await session?.disconnect().catch(() => undefined);
    session = null;
  });

  it('levert een videotrack en meet de tijd tot het eerste frame', async () => {
    const provider = new BeyondPresenceAvatarProvider({
      apiKey: process.env['BEY_API_KEY']!,
      avatarId: process.env['BEY_AVATAR_ID']!,
      livekit: credentials!,
      sampleRate: SAMPLE_RATE,
    });

    const startedAt = performance.now();
    session = await provider.createSession({
      avatarId: process.env['BEY_AVATAR_ID']!,
      language: 'nl',
      roomName: `bakeoff-bey-${Math.random().toString(36).slice(2, 8)}`,
      sampleRate: SAMPLE_RATE,
    });
    const sessionReadyMs = Math.round(performance.now() - startedAt);

    let firstFrameAt = 0;
    const firstFrame = new Promise<void>((resolve) => {
      session!.on('first_frame', () => {
        firstFrameAt = performance.now();
        resolve();
      });
      setTimeout(resolve, 30_000);
    });

    // Audio aanleveren zodat de worker iets heeft om op te renderen.
    const audioStartedAt = performance.now();
    for (const frame of stilte(2000)) {
      await session.pushAudio(frame, 0);
      await new Promise((r) => setTimeout(r, FRAME_MS));
    }

    await firstFrame;

    const tijdTotFrame = firstFrameAt > 0 ? Math.round(firstFrameAt - audioStartedAt) : -1;

    // eslint-disable-next-line no-console
    console.log(
      `\n  Beyond Presence\n` +
        `    sessie opzetten      ${sessionReadyMs} ms  (prewarm dekt dit af)\n` +
        `    audio -> eerste frame ${tijdTotFrame} ms  (budget p50 180 / p95 350)\n`,
    );

    // Dat er een frame kwam is de harde eis; het getal is de meting.
    expect(firstFrameAt).toBeGreaterThan(0);
    expect(tijdTotFrame).toBeGreaterThan(0);
  }, 120_000);
});
