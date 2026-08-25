import { describe, expect, it } from 'vitest';
import { downsamplePcm16, naarPcm16k, upsamplePcm16 } from './resample';
import { teltTikken, teltTikkenPcm16 } from './tikken';

/**
 * Het gereedschap waarmee we de tikken gaan onderzoeken moet zelf boven twijfel staan.
 *
 * Een detector die niets vindt bewijst niets als hij ook een echte tik niet vindt, en een
 * resampler die "schoon" meet bewijst niets als de detector blind is voor zijn artefacten.
 * Deze tests leggen beide kanten vast vóórdat er een leverancier mee wordt beoordeeld.
 */

const SR = 16_000;

/** Een zuivere toon, het schoonste signaal dat er is. */
function toon(hz: number, seconden: number, rate = SR, amplitude = 0.5): Float32Array {
  const n = Math.round(seconden * rate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = Math.sin((2 * Math.PI * hz * i) / rate) * amplitude;
  return x;
}

function naarPcm(x: Float32Array): Int16Array {
  const p = new Int16Array(x.length);
  for (let i = 0; i < x.length; i += 1) p[i] = Math.round((x[i] as number) * 32767);
  return p;
}

describe('teltTikken', () => {
  it('vindt niets in een zuivere toon', () => {
    expect(teltTikken(toon(440, 1), SR).aantal).toBe(0);
  });

  it('vindt een ingebrachte discontinuïteit, en op de goede plek', () => {
    const x = toon(440, 1);
    // Eén sample die niet bij zijn buren past: precies wat een tik is.
    x[8000] = 0.95;

    const m = teltTikken(x, SR);
    expect(m.aantal).toBeGreaterThanOrEqual(1);
    expect(m.posities[0]).toBeGreaterThan(480);
    expect(m.posities[0]).toBeLessThan(520);
  });

  it('telt één klik één keer en niet twintig keer', () => {
    const x = toon(440, 1);
    x[8000] = 0.95;
    x[8001] = -0.9;
    x[8002] = 0.92;
    expect(teltTikken(x, SR).aantal).toBe(1);
  });

  it('gaat niet af op een scherpe inzet zoals spraak die heeft', () => {
    // Een plosief is een snelle maar continue stijging over enkele milliseconden. Zou de
    // detector daarop afgaan, dan meet hij hoeveel medeklinkers er in een zin zitten.
    const x = toon(440, 1);
    for (let i = 0; i < x.length; i += 1) {
      const t = i / SR;
      const envelop = t < 0.5 ? 0 : Math.min(1, (t - 0.5) / 0.004);
      x[i] = (x[i] as number) * envelop;
    }
    expect(teltTikken(x, SR).aantal).toBe(0);
  });

  it('negeert ruis in stilte', () => {
    const x = new Float32Array(SR);
    // Kwantisatieruis rond nul: de mediaan is daar zo klein dat elke sample anders zou
    // opvallen. De stiltegrens hoort dat af te vangen.
    for (let i = 0; i < x.length; i += 1) x[i] = ((i * 37) % 7) / 32768 - 3 / 32768;
    expect(teltTikken(x, SR).aantal).toBe(0);
  });
});

describe('upsamplePcm16', () => {
  it('levert de juiste lengte voor 16 → 24 kHz', () => {
    const uit = upsamplePcm16(naarPcm(toon(1000, 1)), 16_000, 24_000);
    expect(uit.length).toBeGreaterThan(23_900);
    expect(uit.length).toBeLessThanOrEqual(24_000);
  });

  it('introduceert zelf geen tikken', () => {
    // De kern van de zaak: als ons opschalen zelf klikt, meet het experiment onze fout.
    const uit = upsamplePcm16(naarPcm(toon(1000, 1)), 16_000, 24_000);
    expect(teltTikkenPcm16(uit, 24_000).aantal).toBe(0);
  });

  it('houdt een hoge toon nauwkeuriger vast dan lineaire interpolatie', () => {
    // 6 kHz zit dicht tegen de Nyquist van 16 kHz. Daar is lineaire interpolatie op zijn
    // slechtst, en daar hoort het verschil dus zichtbaar te zijn.
    const bron = naarPcm(toon(6000, 0.25));
    const goed = upsamplePcm16(bron, 16_000, 24_000);

    const naief = new Int16Array(goed.length);
    for (let m = 0; m < naief.length; m += 1) {
      const t = (m * 16_000) / 24_000;
      const i = Math.floor(t);
      const f = t - i;
      const a = bron[i] ?? 0;
      const b = bron[i + 1] ?? a;
      naief[m] = Math.round(a + (b - a) * f);
    }

    const foutTegenIdeaal = (p: Int16Array): number => {
      let max = 0;
      // Randen overslaan: daar is de kernel afgekapt en dat is een bekend, apart effect.
      for (let m = 64; m < p.length - 64; m += 1) {
        const ideaal = Math.sin((2 * Math.PI * 6000 * m) / 24_000) * 0.5 * 32767;
        max = Math.max(max, Math.abs((p[m] as number) - ideaal));
      }
      return max / 32767;
    };

    expect(foutTegenIdeaal(goed)).toBeLessThan(foutTegenIdeaal(naief) / 5);
    expect(foutTegenIdeaal(goed)).toBeLessThan(0.02);
  });

  it('weigert af te schalen in plaats van iets plausibels te doen', () => {
    expect(() => upsamplePcm16(new Int16Array(100), 24_000, 16_000)).toThrow(/alleen op/);
  });

  it('geeft de invoer ongewijzigd terug bij een gelijke rate', () => {
    const p = naarPcm(toon(440, 0.1));
    expect(upsamplePcm16(p, 16_000, 16_000)).toBe(p);
  });

  it('kan een leeg signaal aan', () => {
    expect(upsamplePcm16(new Int16Array(0), 16_000, 24_000).length).toBe(0);
  });
});

/**
 * De randgevallen die de detector werkelijk hebben laten omvallen.
 *
 * De eerste versie gebruikte één drempel over de hele opname. Die vond 154 "tikken" in
 * 6,4 seconde schone Cartesia-audio, en de vergelijking die erop volgde was ruis. Oorzaak:
 * spraak is niet stationair. Deze tests leggen dat vast met signalen die dat karakter
 * hebben, zodat een volgende versie er niet opnieuw op kan struikelen.
 */
describe('teltTikken op spraakachtig materiaal', () => {
  /** Deterministische ruis: geen Math.random, anders is een falende test niet na te spelen. */
  function ruis(n: number, amplitude: number, zaad = 12345): Float32Array {
    const x = new Float32Array(n);
    let s = zaad;
    for (let i = 0; i < n; i += 1) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      x[i] = (s / 0x3fffffff - 1) * amplitude;
    }
    return x;
  }

  /** Klinker, sisklank, klinker — precies de afwisseling waar één drempel op stukloopt. */
  function spraakachtig(): Float32Array {
    const n = SR;
    const x = new Float32Array(n);
    const sis = ruis(n, 1);
    for (let i = 0; i < n; i += 1) {
      const t = i / SR;
      // Een sisklank in het midden: bijna ruis, en tientallen keren steiler dan een
      // klinker. Zacht in- en uitgefade, want een harde grens zou zelf een tik zijn.
      const isSis = t > 0.4 && t < 0.6;
      const rand = Math.min(1, Math.min(Math.abs(t - 0.4), Math.abs(t - 0.6)) / 0.02);
      x[i] = isSis
        ? (sis[i] as number) * 0.25 * rand + Math.sin(2 * Math.PI * 180 * t) * 0.1 * (1 - rand)
        : Math.sin(2 * Math.PI * 180 * t) * 0.4;
    }
    return x;
  }

  it('gaat niet af op een sisklank tussen twee klinkers', () => {
    expect(teltTikken(spraakachtig(), SR).aantal).toBe(0);
  });

  it('vindt een tik in de zachte aanloop naar een sisklank', () => {
    // Vlak vóór de sisklank, waar het signaal nog gedragen is. Dat is waar de hoorbare
    // tikken in de praktijk vallen: op chunkgrenzen, niet midden in ruis.
    const x = spraakachtig();
    x[5000] = 0.99;
    x[5001] = -0.99;
    const m = teltTikken(x, SR);
    expect(m.aantal).toBeGreaterThanOrEqual(1);
    expect(m.posities.some((p) => Math.abs(p - 312) < 20)).toBe(true);
  });

  it('is blind voor een tik die midden ín breedbandige ruis valt — en dat is een grens', () => {
    /*
     * Dit is een beperking, geen bug, en hij hoort vastgelegd te zijn omdat hij begrenst
     * wat "nul tikken" betekent.
     *
     * Gemeten op dit materiaal: een klik op volle schaal steekt binnen een sisklank 12,2×
     * boven de lokale mediaan uit, terwijl de schoonste samples daar al 14,6× halen. De
     * klik is dus zwakker dan het luidruchtigste dat er van nature staat. Geen drempel
     * scheidt die twee — de tweede afgeleide draagt daar simpelweg de informatie niet.
     *
     * De drempel op 25 zetten is daarom een keuze vóór betrouwbaarheid: geen valse
     * meldingen, ten koste van gevoeligheid in ruis. Hem verlagen tot de klik hierboven
     * wél gevonden wordt, zou de sisklanken zelf gaan tellen — en dat is precies de fout
     * die deze detector in zijn eerste versie maakte.
     */
    const x = spraakachtig();
    x[8000] = 0.99;
    x[8001] = -0.99;
    expect(teltTikken(x, SR).aantal).toBe(0);
  });

  it('gaat niet af op breedbandige ruis op zichzelf', () => {
    expect(teltTikken(ruis(SR, 0.3), SR).aantal).toBe(0);
  });
});

describe('downsamplePcm16', () => {
  /**
   * Het geval waar dit voor bestaat: Safari levert 48 kHz waar wij 16 kHz vroegen.
   *
   * De oude gesprekspagina labelde die audio gewoon als 16 kHz. Het gevolg is niet ruis
   * maar spraak die drie keer te snel bij de STT aankomt — en dat ziet eruit als een
   * kapotte spraakherkenning in plaats van een verkeerd etiket.
   */
  it('levert de juiste lengte voor 48 → 16 kHz', () => {
    const uit = downsamplePcm16(naarPcm(toon(440, 1, 48_000)), 48_000, 16_000);
    expect(uit.length).toBeGreaterThan(15_900);
    expect(uit.length).toBeLessThanOrEqual(16_000);
  });

  it('houdt de toonhoogte gelijk', () => {
    // Het hele punt. Een verkeerde herbemonstering verschuift de frequentie, en dat is
    // precies wat de STT onbruikbaar maakt. Nuldoorgangen tellen is een directe maat.
    const uit = downsamplePcm16(naarPcm(toon(440, 1, 48_000)), 48_000, 16_000);
    let doorgangen = 0;
    for (let i = 65; i < uit.length - 64; i += 1) {
      const a = uit[i - 1] as number;
      const b = uit[i] as number;
      if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) doorgangen += 1;
    }
    // 440 Hz over ongeveer een seconde: 880 nuldoorgangen, met wat marge voor de randen.
    expect(doorgangen).toBeGreaterThan(850);
    expect(doorgangen).toBeLessThan(890);
  });

  it('introduceert zelf geen tikken', () => {
    const uit = downsamplePcm16(naarPcm(toon(1000, 1, 48_000)), 48_000, 16_000);
    expect(teltTikkenPcm16(uit, 16_000).aantal).toBe(0);
  });

  it('filtert wat boven de uitvoer-Nyquist ligt in plaats van het terug te vouwen', () => {
    /*
     * De kern van het verschil met opschalen.
     *
     * 12 kHz past in 48 kHz maar niet in 16 kHz — de Nyquist ligt daar op 8 kHz. Zonder
     * filter vouwt die toon terug naar 4 kHz en blijft hij even luid; met filter hoort er
     * vrijwel niets over te blijven. Zonder deze regel klinkt spraak blikkerig, en dat is
     * niet meer te repareren nadat het is gebeurd.
     */
    const uit = downsamplePcm16(naarPcm(toon(12_000, 0.5, 48_000, 0.9)), 48_000, 16_000);
    let piek = 0;
    for (let i = 200; i < uit.length - 200; i += 1) {
      piek = Math.max(piek, Math.abs((uit[i] as number) / 32767));
    }
    expect(piek).toBeLessThan(0.05);
  });

  it('laat een toon onder de Nyquist wél door', () => {
    // Zonder deze helft bewijst de test hierboven niets: een filter dat alles wegsnijdt
    // slaagt er ook voor.
    const uit = downsamplePcm16(naarPcm(toon(1000, 0.5, 48_000, 0.9)), 48_000, 16_000);
    let piek = 0;
    for (let i = 200; i < uit.length - 200; i += 1) {
      piek = Math.max(piek, Math.abs((uit[i] as number) / 32767));
    }
    expect(piek).toBeGreaterThan(0.8);
  });

  it('weigert op te schalen', () => {
    expect(() => downsamplePcm16(new Int16Array(100), 16_000, 48_000)).toThrow(/alleen af/);
  });
});

describe('naarPcm16k', () => {
  it('kiest de goede richting en laat 16 kHz met rust', () => {
    const bij16 = naarPcm(toon(440, 0.1, 16_000));
    expect(naarPcm16k(bij16, 16_000)).toBe(bij16);
    expect(naarPcm16k(naarPcm(toon(440, 0.1, 48_000)), 48_000).length).toBeGreaterThan(1500);
    expect(naarPcm16k(naarPcm(toon(440, 0.1, 8_000)), 8_000).length).toBeGreaterThan(1500);
  });
});
