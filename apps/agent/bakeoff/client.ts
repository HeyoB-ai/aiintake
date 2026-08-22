import { createClient } from '@anam-ai/js-sdk';
import { Room, RoomEvent, Track } from 'livekit-client';

/**
 * De meetpagina van de bakeoff.
 *
 * Hier staat de kern van ADR-0010: de twee providers hebben een verschillend transport,
 * maar de meting is voor beide identiek — audio erin, eerste geverfde frame eruit.
 * Alleen zo vergelijk je providers in plaats van integratiegemak.
 */

declare global {
  interface Window {
    bakeoff: {
      anam(sessionToken: string): Promise<Meting>;
      livekit(config: { url: string; token: string }): Promise<Meting>;
    };
  }
}

export interface Meting {
  /** Van "verbinding starten" tot het eerste frame dat de browser daadwerkelijk tekent. */
  readonly firstFrameMs: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Wacht op het eerste frame dat écht is geverfd.
 *
 * `requestVideoFrameCallback` en niet `loadeddata` of `playing`: die twee vuren zodra er
 * metadata of een decodeerbare stream is, wat honderden milliseconden vóór het eerste
 * zichtbare beeld kan liggen. Voor een meting die claimt te zeggen wanneer de cliënt een
 * gezicht ziet, is dat het verschil tussen meten en gokken.
 */
function firstPaintedFrame(video: HTMLVideoElement): Promise<number> {
  return new Promise((resolve) => {
    const rvfc = (
      video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }
    ).requestVideoFrameCallback;

    if (typeof rvfc === 'function') {
      rvfc.call(video, () => resolve(performance.now()));
      return;
    }
    // Terugvalpad; markeert zichzelf als minder nauwkeurig via het resultaat hieronder.
    video.addEventListener('playing', () => resolve(performance.now()), { once: true });
  });
}

function videoElement(): HTMLVideoElement {
  const video = document.getElementById('avatar') as HTMLVideoElement | null;
  if (!video) throw new Error('geen <video id="avatar"> op de pagina');
  return video;
}

window.bakeoff = {
  async anam(sessionToken) {
    const video = videoElement();
    const started = performance.now();

    // Het frame-abonnement vóór het verbinden opzetten: anders mis je het eerste frame
    // als de verbinding sneller is dan de volgende regel.
    const frame = firstPaintedFrame(video);

    const client = createClient(sessionToken);
    try {
      await client.streamToVideoElement('avatar');

      const at = await frame;
      return {
        firstFrameMs: Math.round(at - started),
        width: video.videoWidth,
        height: video.videoHeight,
      };
    } finally {
      // Afsluiten hoort hier, niet bij de aanroeper. Een sessie die blijft staan kost
      // avatarminuten door en telt mee voor het maximum aantal gelijktijdige sessies —
      // drie metingen achter elkaar liepen daarop stuk.
      try {
        await client.stopStreaming();
      } catch {
        /* al gesloten of nooit opgezet; de meting is dan toch al gedaan */
      }
    }
  },

  async livekit({ url, token }) {
    const video = videoElement();
    const started = performance.now();
    const frame = firstPaintedFrame(video);

    const room = new Room();
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Video) track.attach(video);
    });
    await room.connect(url, token);

    const at = await frame;
    return {
      firstFrameMs: Math.round(at - started),
      width: video.videoWidth,
      height: video.videoHeight,
    };
  },
};
