import type { AvatarProviderId, Language } from '@intake/domain';

/**
 * De avatarlaag, audio-first.
 *
 * `speak(text)` zou de TTS van de leverancier de abstractie in trekken en de
 * onderbrekingssemantiek dubbelzinnig maken. Daarom leveren wij PCM aan en rendert de
 * vendor alleen het gezicht: de Nederlandse stemkwaliteit en de latency blijven in
 * eigen hand, en wisselen van leverancier is een configuratieregel.
 *
 * `speakText` bestaat als terugvalpad voor leveranciers zonder audio passthrough. Wie
 * dat pad gebruikt, levert de stemkeuze uit handen — daarom is het optioneel en niet
 * de norm.
 */

export interface AvatarCapabilities {
  /** Wij leveren PCM. Voorkeurspad. */
  readonly audioPassthrough: boolean;
  /** De vendor doet de TTS. Alleen als passthrough ontbreekt. */
  readonly textDriven: boolean;
  /** Harde eis: zonder onderbreken is barge-in onmogelijk. */
  readonly interrupt: boolean;
  /** Harde eis: een bevroren gezicht tussen beurten leest als een storing. */
  readonly idleMotion: boolean;
}

export interface AvatarSessionOptions {
  readonly avatarId: string | null;
  readonly language: Language;
  /** Naam van de room waarin de videotrack gepubliceerd wordt. */
  readonly roomName: string | null;
}

/** Wat de transportlaag teruggeeft; opzettelijk niet getypeerd naar één SDK. */
export interface TrackHandle {
  readonly kind: 'video';
  readonly id: string;
}

export interface AvatarEvents {
  /** Het eerste frame is zichtbaar. Sluit de latencymeting van deze beurt. */
  first_frame: () => void;
  speaking_start: () => void;
  speaking_end: () => void;
  error: (error: Error) => void;
}

export interface AvatarSession {
  pushAudio(pcm: Int16Array, seq: number): Promise<void>;
  speakText?(text: string): Promise<void>;
  /**
   * Stopt onmiddellijk en gooit de wachtrij weg.
   *
   * `spokenMs` is het hele punt van deze signatuur: zonder dat getal weet je niet waar
   * je de assistent-beurt moet afkappen, en dan komt er in het transcript te staan wat
   * de cliënt nooit gehoord heeft.
   */
  interrupt(): Promise<{ spokenMs: number }>;
  videoTrack(): Promise<TrackHandle>;
  on<E extends keyof AvatarEvents>(event: E, handler: AvatarEvents[E]): void;
  disconnect(): Promise<void>;
}

export interface AvatarProvider {
  readonly id: AvatarProviderId;
  readonly capabilities: AvatarCapabilities;
  createSession(options: AvatarSessionOptions): Promise<AvatarSession>;
}
