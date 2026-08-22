import type { VisualSignals } from '@intake/domain';

/**
 * Visuele signalen, uitsluitend browser-side.
 *
 * Deze interface bestaat in Fase 1 zodat de vorm vastligt; de implementatie
 * (MediaPipe FaceLandmarker via WASM, 5–8 fps) komt in Fase 6.
 *
 * De harde grens staat in het type van het event: er gaan alleen booleans over de
 * datachannel. Er verlaat geen enkel videoframe het apparaat voor analyse, en de
 * cliëntcamera wordt standaard niet naar de room gepubliceerd
 * (docs/ADR-0004-clientcamera-blijft-lokaal.md).
 *
 * Wat hier NIET komt: emotieherkenning. Zie docs/ADR-0005 — de interface mag bestaan,
 * de implementatie niet.
 */
export interface VisualSignalOptions {
  /** Bewust laag: meer levert geen betere pacing op en kost accu en CPU. */
  readonly fps?: number;
}

export interface VisualSignalProvider {
  readonly id: string;
  start(video: HTMLVideoElement, options?: VisualSignalOptions): Promise<void>;
  on(event: 'signals', handler: (signals: VisualSignals) => void): void;
  stop(): Promise<void>;
}
