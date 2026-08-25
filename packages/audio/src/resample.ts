/**
 * Opschalen van PCM naar een hogere samplerate, met een gevensterde sinc.
 *
 * ## Waarom dit bestaat
 *
 * Cartesia's WebSocket levert alleen 16 kHz (risico 12). Anam neemt 24 kHz aan. Er zit dus
 * hoe dan ook een resamplingstap tussen, en de vraag is alleen wíé hem doet. Als hun
 * resampler de hoorbare tikken veroorzaakt, kunnen we die stap voor zijn door zelf op te
 * schalen — mits ons opschalen zelf geen artefacten introduceert.
 *
 * Daarom géén lineaire interpolatie. Die is goedkoop en klinkt ook zo: lineair
 * interpoleren is een driehoeksvenster in de tijd, wat in het spectrum een sinc² is met
 * zijlobben die tot ver boven de doorlaatband doorlekken. Precies het soort artefact dat
 * we onderzoeken — je zou dan je eigen fout meten.
 *
 * Hier staat bandbeperkte interpolatie: elke uitvoersample is een gewogen som van de
 * omliggende invoersamples, met een sinc-kernel die op de Nyquist van de *invoer* is
 * afgesneden en met een Blackman-Harris-venster is afgekapt.
 *
 * ## Niet geschikt voor losse chunks in een stroom
 *
 * Deze functie werkt op één afgesloten buffer. Buiten het signaal neemt hij nul aan, en
 * dat is voor een compleet fragment het juiste antwoord. Roep je hem per chunk aan in een
 * streamende keten, dan krijgt **elke chunkgrens** dat randeffect: de kernel loopt aan
 * weerszijden leeg en er ontstaat een discontinuïteit. Je zou dan tikken toevoegen op
 * precies de plekken waar we ze aan het onderzoeken zijn.
 *
 * Voor streaming is een variant nodig die de staart van de vorige chunk als aanloop
 * meeneemt — {@link HALVE_BREEDTE} samples overlap. Die staat hier bewust niet: hem
 * bouwen zonder hem te meten zou het probleem verplaatsen in plaats van oplossen.
 *
 * ## Op- en afschalen zijn twee functies
 *
 * `upsamplePcm16` snijdt de kernel af op de Nyquist van de *invoer*; `downsamplePcm16` op
 * die van de *uitvoer*, want anders vouwt alles boven die grens terug als aliasing. Elk
 * weigert het geval van de ander in plaats van iets plausibels te doen — dat onderscheid
 * stilzwijgend fout krijgen klinkt als een blikkerige, rommelige opname en wijst nergens
 * naar de oorzaak.
 */

/**
 * Halve kernelbreedte in invoersamples.
 *
 * 16 aan elke kant, dus 32 taps. Genoeg voor een stopbanddemping ruim onder de
 * kwantisatieruis van 16-bit; breder maakt het meetbaar trager en hoorbaar niets.
 */
const HALVE_BREEDTE = 16;

/** sinc(x) = sin(pi x) / (pi x), met de limiet 1 in x = 0. */
function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

/**
 * Blackman-Harris, vier termen.
 *
 * `u` loopt van -1 tot 1 over de halve kernelbreedte. Buiten dat bereik nul, zodat de
 * kernel eindig is en er geen sprongetje aan de rand overblijft — dat sprongetje zou
 * zelf een tik zijn.
 */
function venster(u: number): number {
  if (u <= -1 || u >= 1) return 0;
  const t = Math.PI * (u + 1); // 0 … 2pi
  return 0.35875 - 0.48829 * Math.cos(t) + 0.14128 * Math.cos(2 * t) - 0.01168 * Math.cos(3 * t);
}

/**
 * Schaalt 16-bit PCM op van `vanRate` naar `naarRate`.
 *
 * Gooit als `naarRate` niet hoger is dan `vanRate`: zie de kop, afschalen vraagt een
 * andere kernel en dit is niet de plek om dat stilzwijgend fout te doen.
 */
export function upsamplePcm16(invoer: Int16Array, vanRate: number, naarRate: number): Int16Array {
  if (!Number.isFinite(vanRate) || !Number.isFinite(naarRate) || vanRate <= 0 || naarRate <= 0) {
    throw new Error(`upsamplePcm16: onzinnige samplerates ${vanRate} → ${naarRate}`);
  }
  if (naarRate === vanRate) return invoer;
  if (naarRate < vanRate) {
    throw new Error(
      `upsamplePcm16 schaalt alleen op, en kreeg ${vanRate} → ${naarRate}. Afschalen vraagt ` +
        'een kernel die op de uitvoer-Nyquist afsnijdt; zonder dat vouwt alles daarboven ' +
        'terug als aliasing.',
    );
  }
  if (invoer.length === 0) return new Int16Array(0);

  const stap = vanRate / naarRate; // < 1: per uitvoersample schuiven we minder dan één invoersample op
  const n = Math.floor((invoer.length - 1) / stap) + 1;
  const uit = new Int16Array(n);

  for (let m = 0; m < n; m += 1) {
    const t = m * stap; // positie in invoersamples, meestal niet geheel
    const eerste = Math.ceil(t - HALVE_BREEDTE);
    const laatste = Math.floor(t + HALVE_BREEDTE);

    let som = 0;
    let gewicht = 0;
    for (let i = eerste; i <= laatste; i += 1) {
      // Buiten het signaal: nul aannemen in plaats van klemmen. Klemmen zou de eerste
      // sample herhalen en dat is een gelijkstroomsprongetje aan het begin — een tik.
      if (i < 0 || i >= invoer.length) continue;
      const u = t - i;
      const h = sinc(u) * venster(u / HALVE_BREEDTE);
      som += (invoer[i] as number) * h;
      gewicht += h;
    }

    // Normaliseren op de som van de gebruikte gewichten. Aan de randen valt een deel van
    // de kernel weg; zonder dit zou het signaal daar in volume inzakken, wat aan het begin
    // van elke beurt als een zachte plof hoorbaar is.
    const waarde = gewicht > 1e-9 ? som / gewicht : 0;
    uit[m] = Math.max(-32768, Math.min(32767, Math.round(waarde)));
  }
  return uit;
}

/**
 * Schaalt 16-bit PCM af naar een lagere samplerate.
 *
 * ## Waarom dit moet bestaan
 *
 * De browser bepaalt de samplerate van de microfoon, niet wij.
 * `new AudioContext({ sampleRate: 16000 })` is een *verzoek*: Chrome op een desktop
 * honoreert het, maar Safari op iOS levert doorgaans de rate van het apparaat — 48000 of
 * 44100. De gesprekspagina ging daar tot nu toe aan voorbij en labelde de audio gewoon als
 * 16 kHz.
 *
 * Het gevolg is geen ruis maar iets veel verwarrenders: de spraak komt drie keer te snel
 * bij Deepgram binnen. Die herkent dan niets of iets willekeurigs, de beurt eindigt nooit,
 * en het lijkt of de spraakherkenning stuk is terwijl de audio alleen verkeerd is
 * geëtiketteerd.
 *
 * ## De kernel snijdt op de uitvoer-Nyquist
 *
 * Dat is het hele verschil met opschalen. Alles boven de halve doelrate moet wég vóór het
 * uitdunnen; blijft het staan, dan vouwt het terug in het hoorbare gebied als een sissende
 * bijklank die geen enkele filter er later nog uit haalt.
 */
export function downsamplePcm16(invoer: Int16Array, vanRate: number, naarRate: number): Int16Array {
  if (!Number.isFinite(vanRate) || !Number.isFinite(naarRate) || vanRate <= 0 || naarRate <= 0) {
    throw new Error(`downsamplePcm16: onzinnige samplerates ${vanRate} → ${naarRate}`);
  }
  if (naarRate === vanRate) return invoer;
  if (naarRate > vanRate) {
    throw new Error(
      `downsamplePcm16 schaalt alleen af, en kreeg ${vanRate} → ${naarRate}. Gebruik ` +
        'upsamplePcm16; die snijdt op de invoer-Nyquist en niet op die van de uitvoer.',
    );
  }
  if (invoer.length === 0) return new Int16Array(0);

  const stap = vanRate / naarRate; // > 1
  const n = Math.floor((invoer.length - 1) / stap) + 1;
  const uit = new Int16Array(n);

  // De kernel wordt uitgerekt met de verhouding: hij moet afsnijden op de uitvoer-Nyquist,
  // die in invoersamples gemeten een factor `stap` lager ligt.
  const halveBreedte = HALVE_BREEDTE * stap;

  for (let m = 0; m < n; m += 1) {
    const t = m * stap;
    const eerste = Math.ceil(t - halveBreedte);
    const laatste = Math.floor(t + halveBreedte);

    let som = 0;
    let gewicht = 0;
    for (let i = eerste; i <= laatste; i += 1) {
      if (i < 0 || i >= invoer.length) continue;
      const u = (t - i) / stap;
      const h = sinc(u) * venster(u / HALVE_BREEDTE);
      som += (invoer[i] as number) * h;
      gewicht += h;
    }

    const waarde = gewicht > 1e-9 ? som / gewicht : 0;
    uit[m] = Math.max(-32768, Math.min(32767, Math.round(waarde)));
  }
  return uit;
}

/**
 * Naar 16 kHz, ongeacht wat de browser leverde.
 *
 * Eén ingang voor de cliënt, zodat er nergens een `if` staat die op de ene plek anders
 * uitvalt dan op de andere.
 */
export function naarPcm16k(invoer: Int16Array, vanRate: number): Int16Array {
  if (vanRate === 16_000) return invoer;
  return vanRate > 16_000
    ? downsamplePcm16(invoer, vanRate, 16_000)
    : upsamplePcm16(invoer, vanRate, 16_000);
}
