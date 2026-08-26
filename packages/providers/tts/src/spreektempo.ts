/**
 * Bewaakt of de audio het tempo heeft dat bij de gevraagde sample rate hoort.
 *
 * ## Waarom dit bestaat
 *
 * Cartesia negeerde `sample_rate` over de WebSocket ooit stilzwijgend en leverde altijd
 * 16 kHz. Wie dan 24 kHz vraagt, krijgt bytes die als 24 kHz worden gelabeld maar 16 kHz zijn:
 * de spraak loopt anderhalf keer te snel. Dat is geen subtiel kwaliteitsverlies maar een
 * kapot gesprek.
 *
 * Op 26 augustus 2026 is gemeten dat beide leveranciers de parameter nu wél honoreren
 * (`pnpm diag:tts-vergelijk`, verhouding 1,52 en 1,47). Daarom staat de `throw` die dat
 * afdwong niet meer in `CartesiaTtsStream.connect()`.
 *
 * Maar een leverancier die het gedrag één keer heeft veranderd, kan het opnieuw veranderen,
 * en de vorige keer merkten we het pas omdat iemand ernaar zocht. Deze wacht is de vervanging
 * van die `throw`: niet vooraf verbieden, maar achteraf controleren en het zeggen.
 *
 * ## Waarom spreektempo en niet iets nauwkeurigers
 *
 * Het is de enige maat die zonder tweede synthese werkt. Duur zegt niets — dezelfde tekst
 * varieert tot 18 procent per generatie — maar woorden per seconde is genormaliseerd op de
 * inhoud.
 *
 * ## Waar de drempel op staat, en hoe krap dat is
 *
 * De eerste versie stond op 5,5 w/s, en die kon de fout waarvoor hij bestaat niet vangen. Op
 * de openingszin gemeten, woorden geteld op spaties:
 *
 *   Cartesia, 24 kHz correct         ongeveer 3,6 w/s   →  fout zou 5,4 geven
 *   ElevenLabs, speed 1,1            ongeveer 3,4 w/s   →  fout zou 5,1 geven
 *   ElevenLabs, speed 1,2 (maximum)  ongeveer 3,9 w/s   ←  het snelste dat legitiem kan
 *
 * Een drempel van 5,5 ligt bóven beide foutwaarden: hij zou nooit afgaan. Vandaar 4,8. Dat
 * laat ruwweg 23 procent ruimte boven het snelste legitieme tempo en vangt een fout van een
 * factor anderhalf met zo'n 12 procent marge.
 *
 * Die marges zijn niet ruim, en dat hoort hier te staan in plaats van in een commit-bericht.
 * Wie het spreektempo van de stem sterk verhoogt — een andere stem, een ander model — hoort
 * deze drempel opnieuw te bekijken. Een bewaker die vals alarm geeft, wordt uitgezet; een
 * bewaker die nooit afgaat, is decoratie.
 */

/** Boven dit tempo kan het niet meer kloppen. Zie de toelichting hierboven. */
const ONMOGELIJK_TEMPO = 4.8;

/** Wat we op de openingszin als normaal hebben gemeten; alleen voor de schatting hieronder. */
const NORMAAL_TEMPO = 3.6;

/**
 * Minimale hoeveelheid waarover we een uitspraak doen.
 *
 * Onder deze grenzen is het meetartefact groter dan het signaal: een beurt van drie woorden
 * krijgt een aanzienlijk deel van zijn duur van de weggesneden aanloop en van de uitloop na
 * het laatste woord.
 */
const MIN_WOORDEN = 8;
const MIN_SECONDEN = 2;

export class SpreektempoWacht {
  private woorden = 0;
  private gemeld = false;

  constructor(private readonly leverancier: string) {}

  /** Tekst die deze beurt is aangeboden. */
  telTekst(tekst: string): void {
    this.woorden += tekst.trim().split(/\s+/u).filter(Boolean).length;
  }

  /** Begin van een nieuwe beurt. */
  reset(): void {
    this.woorden = 0;
  }

  /**
   * Einde van een beurt. Levert een melding op als het tempo niet kan kloppen, anders `null`.
   *
   * Meldt hoogstens één keer per stream: gaat er iets structureel mis met de rate, dan is dat
   * één probleem en niet één per beurt.
   */
  controleer(gesprokenMs: number, sampleRate: number): string | null {
    if (this.gemeld) return null;
    const seconden = gesprokenMs / 1000;
    if (this.woorden < MIN_WOORDEN || seconden < MIN_SECONDEN) return null;

    const tempo = this.woorden / seconden;
    if (tempo <= ONMOGELIJK_TEMPO) return null;

    this.gemeld = true;
    const echteRate = Math.round(sampleRate / (tempo / NORMAAL_TEMPO));
    return (
      `${this.leverancier}: ${tempo.toFixed(1)} woorden per seconde bij een gevraagde ` +
      `sample rate van ${sampleRate} Hz. Dat tempo bestaat niet in gesproken Nederlands. ` +
      'De meest waarschijnlijke verklaring is dat de leverancier de gevraagde rate negeert ' +
      `en trager materiaal levert — ruwweg ${echteRate} Hz. De cliënt hoort dan spraak die ` +
      'te snel loopt. Controleer met `pnpm diag:tts-vergelijk`.'
    );
  }
}
