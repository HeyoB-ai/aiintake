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
      anamPerBeurt(sessionToken: string, zin: string): Promise<BeurtMeting>;
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

export interface BeurtMeting {
  /** Koude start, alleen ter referentie: prewarm dekt deze af. */
  readonly coldStartMs: number;
  /**
   * Van opdracht tot hoorbaar geluid, binnen een sessie die al draait.
   *
   * Dít is het getal dat tegen het budget van 180 ms p50 mag: de avatarstap zoals de
   * cliënt hem per beurt ervaart.
   */
  readonly responseMs: number;
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

  /**
   * De per-beurt meting: hoe lang duurt het voordat de avatar geluid maakt?
   *
   * Meet vanaf een sessie die al warm is, want dat is de situatie in een gesprek. De
   * koude start wordt apart teruggegeven, puur ter referentie.
   *
   * Detectie via een AnalyserNode op de ontvangen audiotrack, niet via een event van de
   * SDK. Een event zegt "ik heb je opdracht aangenomen"; de RMS-drempel zegt "er komt
   * geluid uit", en dat laatste is wat de cliënt hoort.
   *
   * Let op de modus: dit meet het tekstgestuurde pad (hun TTS). Onze architectuur
   * gebruikt audio passthrough — wij leveren PCM en zij renderen alleen. Dat pad loopt
   * via een andere SDK-aanroep en is hiermee dus nog niet gemeten.
   */
  async anamPerBeurt(sessionToken, zin) {
    const video = videoElement();
    const coldStart = performance.now();
    const frame = firstPaintedFrame(video);

    const client = createClient(sessionToken);
    try {
      await client.streamToVideoElement('avatar');
      const firstFrameAt = await frame;

      // Even laten stabiliseren: idle motion en de audiopijplijn moeten op gang zijn,
      // anders meet je nog een stukje opstarttijd mee.
      await new Promise((r) => setTimeout(r, 1500));

      const stream = (video as HTMLVideoElement & { srcObject: MediaStream | null }).srcObject;
      if (!stream || stream.getAudioTracks().length === 0) {
        throw new Error('geen audiotrack op de avatarstream');
      }

      const audio = new AudioContext();
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      audio.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(analyser);
      const buffer = new Float32Array(analyser.fftSize);

      const rms = (): number => {
        analyser.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) sum += sample * sample;
        return Math.sqrt(sum / buffer.length);
      };

      // Drempel boven de ruisvloer van een stille lijn, ruim onder spraakniveau.
      const DREMPEL = 0.01;
      const opdrachtAt = performance.now();
      await client.talk(zin);

      const geluidAt = await new Promise<number>((resolve, reject) => {
        const deadline = opdrachtAt + 15_000;
        const tick = () => {
          if (rms() > DREMPEL) return resolve(performance.now());
          if (performance.now() > deadline) return reject(new Error('geen geluid binnen 15s'));
          requestAnimationFrame(tick);
        };
        tick();
      });

      await audio.close();

      return {
        coldStartMs: Math.round(firstFrameAt - coldStart),
        responseMs: Math.round(geluidAt - opdrachtAt),
      };
    } finally {
      try {
        await client.stopStreaming();
      } catch {
        /* al gesloten */
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
