/**
 * Tikken tellen in een audiosignaal.
 *
 * Een tik is een discontinuïteit: één of twee samples die niet passen bij hun buren. Op
 * het gehoor is dat een klik; in het signaal is het een uitschieter in de **tweede
 * afgeleide**, `x[n] - 2·x[n-1] + x[n-2]`. Die maat is ongevoelig voor het signaalniveau
 * en voor een gelijkmatige helling, en gevoelig voor precies wat we zoeken.
 *
 * ## Waarom een robuuste drempel en geen vaste
 *
 * Spraak heeft van nature scherpe inzetten — een plosief is óók een sprong. Een vaste
 * drempel telt die mee en dan meet je hoeveel medeklinkers er in de zin zitten. Daarom
 * wordt de drempel afgeleid van de **mediaan** van de tweede afgeleide over het signaal
 * zelf: uitschieters verschuiven een mediaan nauwelijks, dus de drempel blijft staan waar
 * hij hoort ook als er tikken in zitten.
 *
 * ## Waarom dit aan beide kanten draait
 *
 * De uitkomst is alleen te duiden als vergelijking. Dezelfde detector op de audio die wij
 * versturen én op de audio die uit de avatar terugkomt: is de bron schoon en de uitkomst
 * niet, dan is de keten ertussen de oorzaak. Twee verschillende detectors zouden dat
 * verschil zelf kunnen maken.
 *
 * **Voorbehoud dat bij elke uitkomst hoort.** De teruggekomen audio is door WebRTC heen
 * geweest en dus opnieuw gecodeerd (Opus). Dat voegt eigen artefacten toe. Absolute
 * aantallen aan de uitvoerkant zeggen daarom weinig; het verschil tússen armen die
 * allemaal dezelfde opnameweg delen, zegt wel iets.
 */

export interface TikMeting {
  /** Aantal gevonden tikken. */
  readonly aantal: number;
  /** Tikken per seconde — de maat waarop armen te vergelijken zijn. */
  readonly perSeconde: number;
  /** Hoe ver de grootste uitschieter boven de mediaan lag. */
  readonly zwaarste: number;
  /** Posities in ms, hooguit de eerste twintig. */
  readonly posities: number[];
  /** Duur van het onderzochte signaal in ms. */
  readonly duurMs: number;
}

/**
 * Hoeveel keer de mediaan een sprong moet zijn om als tik te tellen.
 *
 * Empirisch: onder ongeveer 20 vangt hij scherpe medeklinkers mee, erboven ontgaan hem
 * zachte klikken. Het getal doet er minder toe dan dat het voor alle armen gelijk is.
 */
const DREMPEL = 25;

/** Twee tikken binnen deze afstand zijn één tik. Anders telt één klik twintig keer. */
const MIN_AFSTAND_MS = 5;

/**
 * Blokgrootte voor de lokale drempel.
 *
 * 25 ms: lang genoeg voor een betrouwbare mediaan (honderden samples), kort genoeg om
 * binnen één foneem te blijven. Bij veel langere blokken loopt een sisklank en de
 * klinker ervoor door elkaar en is de drempel weer een compromis tussen beide.
 */
const BLOK_MS = 25;

/** Onder dit niveau is het stilte; daar is de tweede afgeleide ruis en geen tik. */
const STILTE = 0.0015;

function mediaan(waarden: Float64Array): number {
  const kopie = Float64Array.from(waarden);
  kopie.sort();
  const m = kopie.length >> 1;
  if (kopie.length === 0) return 0;
  return kopie.length % 2 === 0
    ? ((kopie[m - 1] as number) + (kopie[m] as number)) / 2
    : (kopie[m] as number);
}

/** Telt tikken in samples die in [-1, 1] liggen. */
export function teltTikken(x: Float32Array, sampleRate: number): TikMeting {
  const duurMs = (x.length / sampleRate) * 1000;
  if (x.length < 3) return { aantal: 0, perSeconde: 0, zwaarste: 0, posities: [], duurMs };

  const d2 = new Float64Array(x.length - 2);
  const actief = new Uint8Array(x.length - 2);
  let aantalActief = 0;
  for (let n = 2; n < x.length; n += 1) {
    d2[n - 2] = Math.abs((x[n] as number) - 2 * (x[n - 1] as number) + (x[n - 2] as number));
    // "Actief" = hier staat werkelijk signaal. Zie hieronder waarom dat de statistiek
    // bepaalt en niet alleen de detectie.
    if (Math.abs(x[n] as number) >= STILTE || Math.abs(x[n - 1] as number) >= STILTE) {
      actief[n - 2] = 1;
      aantalActief += 1;
    }
  }

  // Geen signaal, geen tikken. Zonder deze uitgang zou de mediaan hieronder over een lege
  // verzameling gaan.
  if (aantalActief === 0) {
    return { aantal: 0, perSeconde: 0, zwaarste: 0, posities: [], duurMs };
  }

  /*
   * De mediaan alleen over de actieve samples.
   *
   * Dit stond eerst over het hele signaal, en dat is fout op precies de signalen die we
   * onderzoeken. Een beurt begint en eindigt met stilte, en digitale stilte geeft een
   * tweede afgeleide van exact nul. Is meer dan de helft van het signaal stil, dan valt de
   * mediaan op nul, zakt de drempel naar de bodemwaarde, en telt élke gewone
   * spraaksample als tik.
   */
  const actieveD2 = new Float64Array(aantalActief);
  let k = 0;
  for (let i = 0; i < d2.length; i += 1) if (actief[i] === 1) actieveD2[k++] = d2[i] as number;
  const globaal = mediaan(actieveD2);

  /*
   * En dan nog een keer, per blok.
   *
   * Eén drempel over de hele opname werkt voor een toon en niet voor spraak. Spraak is
   * niet stationair: een klinker heeft een gladde golfvorm met een kleine tweede
   * afgeleide, een sisklank is bijna ruis en heeft er een die tientallen keren groter is.
   * Een globale mediaan ligt daar ergens tussenin, en dan telt elke sisklank als tik.
   *
   * Dat is geen theorie. Met een globale drempel vond deze detector 154 "tikken" in 6,4
   * seconde schone Cartesia-audio — audio die nooit door een avatar is geweest. De
   * uitvoercijfers die daarop volgden leken een vergelijking maar waren ruis.
   *
   * Per blok van {@link BLOK_MS} een eigen mediaan lost dat op: één klik verschuift de
   * mediaan van vierhonderd samples niet, maar de drempel volgt wel het karakter van dit
   * stukje geluid.
   */
  const blok = Math.max(16, Math.round((BLOK_MS / 1000) * sampleRate));
  const drempelPerBlok = new Float64Array(Math.ceil(d2.length / blok));
  for (let b = 0; b < drempelPerBlok.length; b += 1) {
    const van = b * blok;
    const tot = Math.min(van + blok, d2.length);
    const stuk = new Float64Array(tot - van);
    for (let i = van; i < tot; i += 1) stuk[i - van] = d2[i] as number;
    const lokaal = mediaan(stuk);
    // Bodem op een fractie van de globale mediaan: in een zacht stuk zou een lokale
    // mediaan van bijna nul de drempel zo laag zetten dat gewone ruis meetelt.
    drempelPerBlok[b] = Math.max(lokaal, globaal / 8) * DREMPEL;
  }

  const minAfstand = Math.round((MIN_AFSTAND_MS / 1000) * sampleRate);
  const posities: number[] = [];
  let aantal = 0;
  let zwaarste = 0;
  let vorige = -minAfstand;

  for (let i = 0; i < d2.length; i += 1) {
    const n = i + 2;
    const waarde = d2[i] as number;
    const grens = drempelPerBlok[Math.floor(i / blok)] as number;
    if (waarde < grens) continue;
    // Alleen waar er ook werkelijk signaal is: in stilte is d2 pure ruis en zou de
    // mediaan-gebaseerde drempel willekeurige samples oppikken.
    if (actief[i] === 0) continue;
    if (n - vorige < minAfstand) continue;
    vorige = n;
    aantal += 1;
    if (grens > 0) zwaarste = Math.max(zwaarste, (waarde / grens) * DREMPEL);
    if (posities.length < 20) posities.push(Math.round((n / sampleRate) * 1000));
  }

  return {
    aantal,
    perSeconde: duurMs > 0 ? (aantal / duurMs) * 1000 : 0,
    zwaarste: Number(zwaarste.toFixed(1)),
    posities,
    duurMs: Math.round(duurMs),
  };
}

/** Zelfde meting op 16-bit PCM. */
export function teltTikkenPcm16(pcm: Int16Array, sampleRate: number): TikMeting {
  const f = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) f[i] = (pcm[i] as number) / 32768;
  return teltTikken(f, sampleRate);
}
