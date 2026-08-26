import type {
  AvatarCapabilities,
  AvatarEvents,
  AvatarProvider,
  AvatarSession,
  AvatarSessionOptions,
  TrackHandle,
} from './contract';

/**
 * De avatarprovider die geen avatar is.
 *
 * Twee doelen, allebei echt:
 *
 *  1. **De hele lus draaien zonder leverancier.** STT, TTS, de beurtcyclus, barge-in,
 *     de truncatie en de latencymeting werken hiermee volledig. Alleen het gezicht
 *     ontbreekt. Dat maakt de duurste onderdelen van Fase 1 testbaar vóórdat er een
 *     contract is.
 *  2. **Kantoren zonder video.** Een intake met alleen microfoon is een volwaardige
 *     modus, geen degradatie. Deze provider is dan de eindtoestand, niet een tijdelijke.
 *
 * De boekhouding van `spokenMs` loopt op een echte afspeelklok en niet op de buffer.
 * Dat onderscheid is het verschil tussen een bruikbare en een misleidende testdouble:
 * zou hij teruggeven hoeveel audio er is aangeleverd, dan luidt het antwoord bij een
 * barge-in altijd "alles is gehoord", klopt de transcript-truncatie hier per ongeluk,
 * en gaat hij pas stuk bij de eerste renderende avatar.
 */
export class NullAvatarSession implements AvatarSession {
  private readonly handlers = new Map<string, Function[]>();
  /** Audio die is aangeleverd. Bovengrens van wat er gehoord kán zijn. */
  private bufferedMs = 0;
  /** Wanneer de weergave van deze beurt begon. */
  private playbackStartedAt: number | null = null;
  private speaking = false;
  private firstFrameSent = false;

  /** Ontvangen fragmenten, voor tests die de audioketen willen volgen. */
  readonly chunks: { seq: number; samples: number }[] = [];
  disconnected = false;

  constructor(
    private readonly sampleRate: number = 16_000,
    /** Injecteerbaar zodat de HUD-meting deterministisch te testen is. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  on<E extends keyof AvatarEvents>(event: E, handler: AvatarEvents[E]): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as Function);
    this.handlers.set(event, list);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }

  async pushAudio(pcm: Int16Array, seq: number): Promise<void> {
    if (this.disconnected) return;

    if (!this.firstFrameSent) {
      // Bij een echte provider is dit het moment waarop het gezicht begint te bewegen.
      // Hier markeert het hetzelfde punt in de tijdlijn, zodat de HUD dezelfde stap
      // meet als straks met een renderende avatar.
      this.firstFrameSent = true;
      this.playbackStartedAt = this.now();
      this.emit('first_frame');
    }
    if (!this.speaking) {
      this.speaking = true;
      this.emit('speaking_start');
    }

    this.chunks.push({ seq, samples: pcm.length });
    this.bufferedMs += (pcm.length / this.sampleRate) * 1000;
  }

  /**
   * Hoeveel er is uitgesproken op dit moment.
   *
   * De klok bepaalt dit, niet de buffer. Een echte avatar krijgt audio sneller
   * aangeleverd dan hij hem afspeelt; onderbreek je halverwege, dan is er minder
   * gehoord dan er is aangeleverd. Zou deze provider gewoon de buffer teruggeven, dan
   * zou de transcript-truncatie hier altijd "alles is gehoord" opleveren en pas bij de
   * eerste echte avatar stukgaan — precies de bug die het moeilijkst te vinden is.
   */
  private playedMs(): number {
    if (this.playbackStartedAt === null) return 0;
    const elapsed = this.now() - this.playbackStartedAt;
    return Math.max(0, Math.min(this.bufferedMs, elapsed));
  }

  async interrupt(): Promise<{ spokenMs: number }> {
    const spokenMs = Math.round(this.playedMs());
    this.sluitBeurt();
    return { spokenMs };
  }

  /**
   * Het einde van een beurt die niet is onderbroken.
   *
   * Deze methode heette `finishTurn` en het contract heet `endTurn`. Omdat `endTurn` in het
   * contract optioneel is, riep de lus hem aan als `avatar.endTurn?.()` — en dat was op deze
   * klasse `undefined`. Geen fout, geen melding: de aanroep deed niets, en niemand riep
   * `finishTurn` ooit aan.
   *
   * Wat daardoor niet gebeurde, na de eerste beurt van elke sessie:
   *
   *  - `firstFrameSent` bleef staan, dus `first_frame` vuurde nooit meer. Daarmee bleef
   *    `totalResponseLatencyMs` — het getal waarop de Fase 1-poort rust — leeg voor elke
   *    beurt behalve de opening.
   *  - `playbackStartedAt` en `bufferedMs` bleven staan. Bij een barge-in in beurt 2 of
   *    later werd `playedMs()` daardoor de tijd sinds het begin van de éérste beurt, tegen
   *    de opgetelde audio van de hele sessie. Dat is altijd meer dan wat deze beurt aan
   *    audio had, en `truncateToSpoken` geeft dan de volledige tekst terug.
   *
   * Dat laatste is precies wat de kop van dit bestand belooft te voorkomen: "zou hij
   * teruggeven hoeveel audio er is aangeleverd, dan luidt het antwoord bij een barge-in
   * altijd 'alles is gehoord'". Dat gebeurde, vanaf de tweede beurt, in elke sessie.
   */
  endTurn(): void {
    this.sluitBeurt();
  }

  /** De boekhouding loopt per beurt: hierna begint de volgende op nul. */
  private sluitBeurt(): void {
    if (this.speaking) {
      this.speaking = false;
      this.emit('speaking_end');
    }
    this.bufferedMs = 0;
    this.playbackStartedAt = null;
    this.firstFrameSent = false;
  }

  async videoTrack(): Promise<TrackHandle> {
    // Er is geen videotrack. De client toont een statische placeholder met het
    // AI-assistent-label; het gesprek verloopt verder identiek.
    return { kind: 'video', id: 'null-placeholder' };
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

export class NullAvatarProvider implements AvatarProvider {
  readonly id = 'null' as const;

  readonly capabilities: AvatarCapabilities = {
    audioPassthrough: true,
    textDriven: false,
    interrupt: true,
    // Er is niets om stil te laten staan; de placeholder is een afbeelding.
    idleMotion: false,
  };

  session: NullAvatarSession | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  async createSession(_options: AvatarSessionOptions): Promise<AvatarSession> {
    this.session = new NullAvatarSession(16_000, this.now);
    return this.session;
  }
}
