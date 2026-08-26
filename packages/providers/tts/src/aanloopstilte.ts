/**
 * Aanloopstilte wegsnijden.
 *
 * ## Waarom dit bestaat
 *
 * Een TTS zet vóór het eerste woord stilte, en die is niet vast: dezelfde zin leverde bij
 * Cartesia in drie achtereenvolgende syntheses 548, 107 en 227 ms op. Het is dus gegenereerde
 * prosodie en geen padding die met een parameter uit te zetten is — de API accepteert
 * onbekende velden bovendien stilzwijgend, dus er valt ook niets aan af te lezen.
 *
 * In productie gaat die stilte gewoon naar de avatar en wacht de cliënt hem uit. Dat is geen
 * meetartefact maar ervaren vertraging, en het is de grootste post die volledig in ons eigen
 * deel van de keten zit.
 *
 * **Alleen vóór het eerste geluid, nooit ertussen.** Stilte binnen een beurt is prosodie: de
 * pauze tussen twee zinnen, de adem voor een bijzin. Die wegsnijden zou van de assistent een
 * ratelaar maken, en het zou dataverlies zijn van dezelfde soort als risico 2 — alleen dan
 * aan de uitgaande kant.
 *
 * ## Waarom het hier staat en niet in de adapter
 *
 * Het stond in `cartesia.ts`. Met een tweede leverancier erbij zouden dat twee kopieën van
 * dezelfde rekenregels worden, en dan kunnen ze het oneens worden over wat er met de audio
 * gebeurt — precies de reden waarom het resamplen destijds naar `@intake/audio` verhuisde.
 *
 * Niet naar `@intake/audio` zelf, want dit is geen signaalbewerking die de browser-cliënt
 * nodig heeft: het is beurt-toestand, en die hoort bij de streams die beurten kennen.
 */

/** Boven deze fractie van de volle schaal noemen we een sample hoorbaar. */
const AUDIBLE_THRESHOLD = 0.003;

/**
 * Wat we vóór het eerste hoorbare sample laten staan.
 *
 * Een medeklinker begint zacht en loopt op. Precies op het eerste sample boven de drempel
 * snijden knipt die aanzet eraf en levert een harde inzet op die klinkt als een fout.
 */
const KEEP_LEAD_MS = 20;

/**
 * Fade-in over het snijpunt.
 *
 * Gemeten is het snijpunt schoon — de bewaarde aanloop van 20 ms landt in near-silence en de
 * grootste sprong in de eerste vijf milliseconde was 16 op een schaal van 32767. Toch staat
 * deze fade er: hij kost niets, en hij neemt de hele klasse "sprong in de golfvorm" weg in
 * plaats van hem per geval te moeten meten. Bij een andere stem of een hardere inzet kan die
 * sprong wél groot zijn — en met een tweede leverancier erbij is "een andere stem" geen
 * hypothetisch geval meer.
 */
const FADE_IN_MS = 8;

/**
 * Bovengrens aan wat er weg mag.
 *
 * Zou er ooit een beurt binnenkomen die veel langer stil blijft, dan is er iets anders aan de
 * hand dan prosodie, en dan hoort dat zichtbaar te worden in plaats van weggesneden.
 */
const MAX_TRIM_MS = 2000;

/** Lineaire fade over de eerste `samples`, zodat het snijpunt geen sprong wordt. */
export function fadeIn(pcm: Int16Array, samples: number): Int16Array {
  const n = Math.min(samples, pcm.length);
  for (let i = 0; i < n; i += 1) pcm[i] = Math.round(pcm[i]! * (i / n));
  return pcm;
}

/**
 * Houdt per beurt bij of we nog naar het eerste geluid zoeken, en hoeveel er weg is.
 *
 * Eén exemplaar per stream. `reset()` hoort bij het begin van een beurt: zonder dat blijft
 * `zoekt` na de eerste beurt op `false` staan en wordt er in beurt 2 en verder niets meer
 * weggesneden, terwijl `weggesnedenMs` een sessietotaal gaat tonen op een plek waar de HUD
 * een beurtwaarde laat zien. Zie risico 18.
 */
export class AanloopSnijder {
  private zoekt = true;
  private weggesneden = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly aan: boolean,
  ) {}

  /** Begin van een nieuwe beurt. */
  reset(): void {
    this.zoekt = true;
    this.weggesneden = 0;
  }

  /** Hoeveel aanloopstilte er deze beurt is weggesneden. */
  get weggesnedenMs(): number {
    return Math.round(this.weggesneden);
  }

  /**
   * Verwerkt één chunk.
   *
   * Levert een leeg fragment op als deze chunk volledig stil is; dan telt hij als
   * weggesneden en hoort hij niet te worden doorgegeven.
   */
  verwerk(pcm: Int16Array): Int16Array {
    if (!this.aan || !this.zoekt) return pcm;

    const grens = AUDIBLE_THRESHOLD * 32767;
    let eerste = 0;
    while (eerste < pcm.length && Math.abs(pcm[eerste]!) <= grens) eerste += 1;

    const chunkMs = (pcm.length / this.sampleRate) * 1000;

    if (eerste >= pcm.length) {
      // Volledig stil. Boven de bovengrens stoppen we met snijden en laten we de rest staan:
      // dan is er iets anders aan de hand dan prosodie.
      if (this.weggesneden + chunkMs > MAX_TRIM_MS) {
        this.zoekt = false;
        return pcm;
      }
      this.weggesneden += chunkMs;
      return new Int16Array(0);
    }

    // Gevonden. Een stukje aanloop laten staan zodat een zachte inzet niet wordt afgekapt.
    const lead = Math.round((KEEP_LEAD_MS / 1000) * this.sampleRate);
    const vanaf = Math.max(0, eerste - lead);
    this.zoekt = false;
    this.weggesneden += (vanaf / this.sampleRate) * 1000;
    if (vanaf === 0) return pcm;

    const uit = pcm.slice(vanaf);
    return fadeIn(uit, Math.round((FADE_IN_MS / 1000) * this.sampleRate));
  }
}

/**
 * Base64 naar PCM, altijd op een even bytegrens.
 *
 * Twee aannames zaten hier eerder in en geen van beide is gegarandeerd: dat `byteOffset` even
 * is (Node deelt Buffers uit een pool; bij een oneven offset gooit `new Int16Array` een
 * RangeError en is de chunk weg) en dat `length` even is (bij een oneven lengte viel de
 * laatste byte onder tafel en begon de vólgende chunk op de verkeerde bytegrens — vanaf dat
 * punt worden twee helften van verschillende samples aan elkaar geplakt, en dat is ruis).
 *
 * Gemeten met `pnpm diag:audio`: nul oneven chunks in twee runs. Het geval deed zich dus niet
 * voor. Het blijft staan als verzekering — het hangt aan hoe de leverancier zijn chunks knipt
 * en aan de Buffer-pool van Node, en met twee leveranciers zijn dat twee onbekenden.
 *
 * `oneven` is `true` als er een byte is afgevallen. De aanroeper hoort dat te melden en niet
 * stil te slikken: gaat dit ooit af, dan is elke sample daarna een byte verschoven.
 */
export function base64NaarPcm(data: string): { pcm: Int16Array; oneven: boolean } {
  const bytes = Buffer.from(data, 'base64');
  const bruikbaar = Math.floor(bytes.length / 2) * 2;
  const uitgelijnd = Buffer.from(bytes.subarray(0, bruikbaar));
  return {
    pcm: new Int16Array(uitgelijnd.buffer, uitgelijnd.byteOffset, bruikbaar / 2),
    oneven: bruikbaar !== bytes.length,
  };
}
