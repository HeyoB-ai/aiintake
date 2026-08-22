import { afterAll, describe, expect, it } from 'vitest';
import {
  LiveKitRooms,
  createAccessToken,
  readLiveKitCredentials,
} from '@intake/provider-transport';

/**
 * LiveKit tegen de echte server.
 *
 * Wat hier wordt vastgesteld: dat de room-API bereikbaar is, dat onze zelfgemaakte
 * tokens worden geaccepteerd, en dat de rechten per rol kloppen. Dat laatste is de
 * reden dat dit een test is en geen handmatige controle — een cliënttoken dat camera
 * mag publiceren zou ADR-0004 stilzwijgend omzeilen.
 */

const credentials = readLiveKitCredentials();
const describeLive = credentials ? describe : describe.skip;

if (!credentials) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[livekit] OVERGESLAGEN — LIVEKIT_URL, LIVEKIT_API_KEY of LIVEKIT_API_SECRET ontbreekt.\n' +
      `Gelezen env-bestanden: ${process.env['INTAKE_ENV_FILES_LOADED'] || '(geen)'}\n`,
  );
}

const ROOM = `intake-test-${Math.random().toString(36).slice(2, 10)}`;

describeLive('LiveKit', () => {
  const rooms = new LiveKitRooms(credentials!);

  afterAll(async () => {
    await rooms.delete(ROOM).catch(() => undefined);
  });

  it('maakt een room aan en ziet hem terug', async () => {
    const created = await rooms.create(ROOM, { emptyTimeoutSeconds: 60 });
    expect(created.name).toBe(ROOM);
    // Via exists(), niet via een ongefilterde list(): LiveKit Cloud toont lege rooms
    // daar niet, en dan lijkt CreateRoom mislukt terwijl hij slaagde.
    expect(await rooms.exists(ROOM)).toBe(true);
  });

  it('ruimt de room weer op', async () => {
    await rooms.delete(ROOM);
    expect(await rooms.exists(ROOM)).toBe(false);
    // Opnieuw aanmaken zodat afterAll niets vreemds tegenkomt.
    await rooms.create(ROOM, { emptyTimeoutSeconds: 60 });
  });

  describe('tokenrechten per rol', () => {
    const claims = (role: 'client' | 'agent' | 'avatar') => {
      const { token } = createAccessToken(credentials!, {
        room: ROOM,
        identity: `x-${role}`,
        role,
      });
      const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
      return payload.video;
    };

    it('de cliënt mag alleen de microfoon publiceren', () => {
      const video = claims('client');
      expect(video.canPublish).toBe(true);
      // De camera blijft lokaal (ADR-0004). Dat hoort in het token te staan en niet
      // alleen in de clientcode, anders is het een afspraak in plaats van een grens.
      expect(video.canPublishSources).toEqual(['microphone']);
    });

    it('de agent publiceert alleen audio, geen video', () => {
      // Publiceren moet: de avatarvendor rendert een gezicht op onze audiotrack. Video
      // publiceren hoeft niet en hoort dus ook niet te mogen.
      const video = claims('agent');
      expect(video.canPublish).toBe(true);
      expect(video.canPublishSources).toEqual(['microphone']);
      expect(video.canSubscribe).toBe(true);
    });

    it('de avatarvendor mag publiceren', () => {
      expect(claims('avatar').canPublish).toBe(true);
    });

    it('elk token is aan één room gebonden', () => {
      expect(claims('client').room).toBe(ROOM);
      expect(claims('client').roomJoin).toBe(true);
    });
  });

  it('een token met het verkeerde secret wordt geweigerd', async () => {
    // Bewijst dat de server de handtekening echt controleert, en dus dat onze
    // ondertekening niet toevallig werkt.
    const bogus = new LiveKitRooms({ ...credentials!, apiSecret: 'x'.repeat(40) });
    await expect(bogus.list()).rejects.toThrow(/40[13]|HTTP/);
  });
});
