import { createClient } from '@anam-ai/js-sdk';
import { Room, RoomEvent, Track } from 'livekit-client';

/**
 * De meetpagina van de bakeoff.
 *
 * Hier staat de kern van ADR-0010: de twee providers hebben een verschillend transport,
 * maar de meting is voor beide identiek — onze audio erin, hoorbaar geluid eruit. Alleen
 * zo vergelijk je providers in plaats van integratiegemak.
 */

declare global {
  interface Window {
    bakeoff: {
      anam(sessionToken: string): Promise<Meting>;
      anamPerBeurt(sessionToken: string, zin: string): Promise<BeurtMeting>;
      anamPassthrough(
        sessionToken: string,
        pcmBase64: string,
        sampleRate: number,
        herhalingen: number,
      ): Promise<PassthroughMeting>;
      beyPassthrough(
        config: { url: string; token: string },
        herhalingen: number,
      ): Promise<PassthroughMeting>;
      livekit(config: { url: string; token: string }): Promise<Meting>;
    };
    /** Door Playwright aangeboden: laat de Node-kant één beurt audio insturen. */
    beyPush?: (index: number) => Promise<void>;
    /** Idem, maar doet niets. Meet de overhead van de brug zelf. */
    harnasNoop?: () => Promise<void>;
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
  readonly responseMs: number;
}

export interface PassthroughMeting {
  readonly coldStartMs: number;
  /** Eén getal per beurt, in volgorde. p50 en p95 worden buiten de browser berekend. */
  readonly responseMs: number[];
  /**
   * Eenmalig gemeten overhead van de Playwright-brug, alleen bij bey.
   *
   * Bij bey zit de verzendkant in Node en de meetkant in de browser. De browser start de
   * klok en vraagt daarna via een `exposeFunction`-brug of Node wil sturen. Die hop zit
   * dus in het getal. Hij wordt niet afgetrokken maar wél gerapporteerd: liever een
   * getal dat te hoog is en waarvan je weet hoeveel, dan een gecorrigeerd getal.
   */
  readonly harnasOverheadMs?: number;
}

/** Drempel boven de ruisvloer van een stille lijn, ruim onder spraakniveau. */
const DREMPEL = 0.01;

/**
 * Detecteert het begin van hoorbaar geluid, op sample-niveau.
 *
 * **Waarom niet met `requestAnimationFrame`.** De eerste versie bemonsterde de RMS in een
 * rAF-lus. Die vuurt ~60 keer per seconde, dus elke meting werd naar boven afgerond op een
 * veelvoud van 16,7 ms. Op een latency van rond de 35 ms is dat geen ruis meer maar een
 * fout van dezelfde orde als het getal zelf — en dan kun je twee providers die 20 ms
 * schelen niet uit elkaar houden.
 *
 * Een `ScriptProcessorNode` krijgt elk blok van 256 samples te zien. Bij 48 kHz is dat elke
 * 5,3 ms, en binnen het blok is precies te zien bij welke sample de drempel wordt
 * overschreden. Daarmee is de onzekerheid ongeveer een milliseconde.
 *
 * De node is formeel verouderd. Het alternatief (AudioWorklet) vraagt een apart
 * modulebestand voor precies dezelfde rekensom; voor een meetharnas dat alleen in
 * Chromium draait weegt dat niet op.
 */
function maakDetector(stream: MediaStream) {
  const audio = new AudioContext();
  const bron = audio.createMediaStreamSource(stream);
  const processor = audio.createScriptProcessor(256, 1, 1);

  let laatsteBlokEindeMs = 0;
  let laatsteRms = 0;
  /** Tijdstip van de eerste sample boven de drempel sinds `wapen()`. */
  let onsetMs: number | null = null;
  let gewapend = false;

  processor.onaudioprocess = (event) => {
    const nu = performance.now();
    laatsteBlokEindeMs = nu;
    const data = event.inputBuffer.getChannelData(0);

    let som = 0;
    let eerste = -1;
    for (let i = 0; i < data.length; i += 1) {
      const sample = data[i] ?? 0;
      som += sample * sample;
      if (eerste === -1 && Math.abs(sample) > DREMPEL) eerste = i;
    }
    laatsteRms = Math.sqrt(som / data.length);

    if (gewapend && onsetMs === null && eerste !== -1) {
      // Het blok is zojuist verwerkt; sample `eerste` lag (lengte - eerste) samples
      // vóór het einde van het blok.
      const terug = ((data.length - eerste) / event.inputBuffer.sampleRate) * 1000;
      onsetMs = nu - terug;
    }
  };

  // Een ScriptProcessorNode draait alleen als hij in de graaf naar de uitgang loopt.
  // Gain op 0, want de meting mag de meting niet horen.
  const stil = audio.createGain();
  stil.gain.value = 0;
  bron.connect(processor);
  processor.connect(stil);
  stil.connect(audio.destination);

  const slaap = (ms: number) => new Promise((r) => setTimeout(r, ms));

  return {
    /** Zet de detector scherp voor een nieuwe beurt. */
    wapen(): void {
      onsetMs = null;
      gewapend = true;
    },
    /** Wacht tot de eerste sample boven de drempel; geeft het tijdstip terug. */
    async wachtOpGeluid(timeoutMs = 15_000): Promise<number> {
      const deadline = performance.now() + timeoutMs;
      while (onsetMs === null) {
        if (performance.now() > deadline) {
          throw new Error(
            `geen hoorbaar geluid binnen ${timeoutMs} ms ` +
              `(laatste RMS ${laatsteRms.toFixed(4)}, laatste blok ${Math.round(
                performance.now() - laatsteBlokEindeMs,
              )} ms geleden)`,
          );
        }
        await slaap(1);
      }
      return onsetMs;
    },
    /** Wacht tot het weer stil is, zodat de volgende beurt schoon begint. */
    async wachtOpStilte(minStilteMs = 400, timeoutMs = 20_000): Promise<void> {
      gewapend = false;
      const deadline = performance.now() + timeoutMs;
      let stilSinds: number | null = null;
      while (performance.now() < deadline) {
        if (laatsteRms <= DREMPEL) {
          stilSinds ??= performance.now();
          if (performance.now() - stilSinds >= minStilteMs) return;
        } else {
          stilSinds = null;
        }
        await slaap(5);
      }
    },
    async sluit(): Promise<void> {
      processor.onaudioprocess = null;
      await audio.close();
    },
  };
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

function metTimeout<T>(promise: Promise<T>, ms: number, wat: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${wat} bleef uit`)), ms)),
  ]);
}

function videoElement(): HTMLVideoElement {
  const video = document.getElementById('avatar') as HTMLVideoElement | null;
  if (!video) throw new Error('geen <video id="avatar"> op de pagina');
  return video;
}

function decodeer(pcmBase64: string): Uint8Array {
  const binary = atob(pcmBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
   * De per-beurt meting op het tekstgestuurde pad: hún TTS zit in de keten.
   *
   * Blijft bestaan als vergelijkingspunt, maar telt niet mee voor de providerkeuze — wij
   * gebruiken passthrough (ADR-0001), en dan is dit getal tijd die we niet betalen.
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

      const detector = maakDetector(new MediaStream(stream.getAudioTracks()));
      try {
        detector.wapen();
        const opdrachtAt = performance.now();
        await client.talk(zin);
        const geluidAt = await detector.wachtOpGeluid();

        return {
          coldStartMs: Math.round(firstFrameAt - coldStart),
          responseMs: Math.round(geluidAt - opdrachtAt),
        };
      } finally {
        await detector.sluit();
      }
    } finally {
      try {
        await client.stopStreaming();
      } catch {
        /* al gesloten */
      }
    }
  },

  /**
   * Anam op ons productiepad: ónze audio erin, hoe snel komt hij eruit?
   *
   * Meerdere beurten in één warme sessie, want dat is de situatie in een gesprek — en
   * omdat p50 en p95 uit één meting niet bestaan.
   */
  async anamPassthrough(sessionToken, pcmBase64, sampleRate, herhalingen) {
    const video = videoElement();
    const coldStart = performance.now();
    const frame = firstPaintedFrame(video);
    const bytes = decodeer(pcmBase64);

    const client = createClient(sessionToken);
    try {
      await client.streamToVideoElement('avatar');
      const firstFrameAt = await metTimeout(frame, 60_000, 'eerste videoframe van Anam');
      await new Promise((r) => setTimeout(r, 1500));

      const stream = (video as HTMLVideoElement & { srcObject: MediaStream | null }).srcObject;
      if (!stream || stream.getAudioTracks().length === 0) {
        throw new Error('geen audiotrack op de avatarstream');
      }

      const detector = maakDetector(new MediaStream(stream.getAudioTracks()));
      const responseMs: number[] = [];

      try {
        for (let beurt = 0; beurt < herhalingen; beurt += 1) {
          const input = client.createAgentAudioInputStream({
            encoding: 'pcm_s16le',
            sampleRate,
            channels: 1,
          });

          const bytesPerFrame = (sampleRate / 1000) * 20 * 2; // 20 ms, 16 bit mono
          detector.wapen();
          const startedAt = performance.now();

          // Op ware snelheid aanleveren: alles in één keer dumpen zou de meting
          // vertekenen, want dan wacht de engine niet op audio die er nog niet is.
          for (let offset = 0, i = 0; offset < bytes.length; offset += bytesPerFrame, i += 1) {
            const wacht = i * 20 - (performance.now() - startedAt);
            if (wacht > 0) await new Promise((r) => setTimeout(r, wacht));
            input.sendAudioChunk(
              bytes.slice(offset, Math.min(offset + bytesPerFrame, bytes.length)),
            );
          }
          input.endSequence();

          const geluidAt = await detector.wachtOpGeluid();
          responseMs.push(Math.round(geluidAt - startedAt));
          await detector.wachtOpStilte();
        }
      } finally {
        await detector.sluit();
      }

      return { coldStartMs: Math.round(firstFrameAt - coldStart), responseMs };
    } finally {
      try {
        await client.stopStreaming();
      } catch {
        /* al gesloten */
      }
    }
  },

  /**
   * Beyond Presence op hetzelfde pad, met hetzelfde getal.
   *
   * Het transport verschilt en dat is precies waarom dit hier staat. Bij Anam stuurt de
   * browser onze PCM de SDK in. Bij bey stuurt de Node-worker hem over een LiveKit
   * DataStream naar de avatarworker, die video én audio terug de room in publiceert; de
   * browser is hier alleen toeschouwer.
   *
   * De klok start dus in de browser en de verzending gebeurt in Node. Die hop zit in het
   * getal en wordt apart gemeten (`harnasOverheadMs`), niet weggerekend.
   */
  async beyPassthrough({ url, token }, herhalingen) {
    if (!window.beyPush || !window.harnasNoop) {
      throw new Error('de Node-brug (beyPush/harnasNoop) is niet aangeboden');
    }

    const video = videoElement();
    const coldStart = performance.now();
    const frame = firstPaintedFrame(video);

    const room = new Room();
    let audioTrack: MediaStreamTrack | null = null;
    const audioBinnen = new Promise<MediaStreamTrack>((resolve) => {
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video) track.attach(video);
        if (track.kind === Track.Kind.Audio) {
          audioTrack = track.mediaStreamTrack;
          resolve(track.mediaStreamTrack);
        }
      });
    });

    try {
      await room.connect(url, token);

      const firstFrameAt = await metTimeout(
        frame,
        60_000,
        'eerste videoframe van de bey-avatar in de room',
      );
      const mst = await metTimeout(audioBinnen, 30_000, 'audiotrack van de bey-avatar in de room');
      void audioTrack;

      await new Promise((r) => setTimeout(r, 1500));

      // De brug meten vóór de eerste beurt, niet erna: hier is de pagina in dezelfde
      // toestand als tijdens de metingen.
      const rondtes: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        const t = performance.now();
        await window.harnasNoop();
        rondtes.push(performance.now() - t);
      }
      rondtes.sort((a, b) => a - b);
      const harnasOverheadMs = Math.round((rondtes[Math.floor(rondtes.length / 2)] ?? 0) / 2);

      const detector = maakDetector(new MediaStream([mst]));
      const responseMs: number[] = [];

      try {
        for (let beurt = 0; beurt < herhalingen; beurt += 1) {
          detector.wapen();
          const startedAt = performance.now();
          // Niet awaiten vóór de detectie: beyPush keert pas terug als alle audio is
          // aangeleverd, en tegen die tijd is het geluid er allang.
          const gestuurd = window.beyPush(beurt);
          const geluidAt = await detector.wachtOpGeluid();
          responseMs.push(Math.round(geluidAt - startedAt));
          await gestuurd;
          await detector.wachtOpStilte();
        }
      } finally {
        await detector.sluit();
      }

      return { coldStartMs: Math.round(firstFrameAt - coldStart), responseMs, harnasOverheadMs };
    } finally {
      await room.disconnect();
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
