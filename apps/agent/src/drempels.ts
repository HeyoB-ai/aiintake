import { BACKCHANNEL_MAX_MS, INTERRUPT_MIN_SPEECH_MS, INTERRUPT_MIN_WORDS } from '@intake/domain';

/**
 * De drempels die het onderbrekingsgedrag bepalen, af te stellen zonder deploy.
 *
 * ## Waarom dit bestaat
 *
 * Dit is gedrag dat je alleen op gehoor kunt afstellen. Of de assistent te schrikachtig is of
 * te doof, blijkt in een gesprek en niet uit een getal — en een deploy per poging maakt dat
 * afstellen onmogelijk. `pnpm diag:bargein` meet wat er gebeurt; deze laag maakt het
 * verstelbaar.
 *
 * ## De standaardwaarden blijven de standaard
 *
 * De constanten in `@intake/domain` veranderen niet. Een omgevingsvariabele is een **afwijking**
 * en geen vervanging: staat hij niet, dan draait er precies wat er in de code staat. Dat is de
 * reden dat de opstartbanner elke waarde toont mét of hij is afgeweken — anders is "welke stand
 * stond er tijdens dat gesprek" achteraf niet te beantwoorden, en dan is het afstellen zelf
 * niets waard.
 *
 * ## Waarom hier en niet in `@intake/domain`
 *
 * Het domein is puur en leest geen omgeving. Zou het dat wel doen, dan hangt het gedrag van een
 * rekenregel af van waar hij toevallig draait, en dan meet een test iets anders dan productie.
 * De constanten blijven daar staan als waarde; het oplossen gebeurt hier, in de laag die de
 * worker opstart.
 *
 * ## Wat er níét in staat
 *
 * De twee drempels van de microfoonpoort staan in de browser (`conversation-client.ts`) en
 * worden meegestuurd in het `ready`-bericht. Ze staan hieronder wél, want anders is de helft
 * van het pad niet af te stellen — maar ze worden niet hier toegepast.
 *
 * Zie RISICOS.md risico 21 voor waaróm deze drempels vandaag niet doen wat hun naam belooft.
 * Verstelbaar maken is geen reparatie: `speechMs` blijft netwerkretour meten in plaats van
 * spraakduur, en geen enkele waarde repareert dat. Dit maakt het onderzoekbaar, niet goed.
 */

export interface Drempels {
  /** `classifySpeech`: minimale `speechMs` voor een harde onderbreking. */
  readonly interruptMinSpeechMs: number;
  /** `classifySpeech`: minimaal aantal woorden in de eerste partial. */
  readonly interruptMinWords: number;
  /** `isBackchannel`: boven deze waarde telt "ja" niet meer als bevestiging. */
  readonly backchannelMaxMs: number;
  /** Deepgram: stilte in ms voor `speech_final`. Bepaalt hoe snel de assistent begint. */
  readonly endpointingMs: number;
  /** Deepgram: vangnet dat de beurt sluit op gaten tussen woordtijdstempels. */
  readonly utteranceEndMs: number;
  /** Extra stilte na een beurt die grammaticaal onafgerond klinkt. 0 zet het uit. */
  readonly onafgerondWachtMs: number;
  /** Browser: RMS waarboven de microfoonpoort opengaat. */
  readonly micGateRms: number;
  /** Browser: hoe lang het stil moet zijn voordat de poort dichtgaat. */
  readonly micGateCloseMs: number;
}

interface Regel {
  readonly env: string;
  readonly sleutel: keyof Drempels;
  readonly standaard: number;
  readonly min: number;
  readonly max: number;
  readonly geheel: boolean;
  readonly waarom: string;
}

/*
 * De grenzen zijn geen smaak.
 *
 * Elke boven- en ondergrens hieronder sluit een waarde uit waarvan we weten wat hij kapotmaakt,
 * en die reden staat erbij. Een bereik zonder reden is een bereik dat de volgende persoon
 * verruimt omdat het in de weg zat.
 */
const REGELS: Regel[] = [
  {
    env: 'INTERRUPT_MIN_SPEECH_MS',
    sleutel: 'interruptMinSpeechMs',
    standaard: INTERRUPT_MIN_SPEECH_MS,
    min: 0,
    max: 5_000,
    geheel: true,
    waarom:
      'Boven de 5 s is de beurt allang via endpointing gesloten en doet deze tak niets meer; ' +
      '0 betekent "elke partial onderbreekt", wat een geldige proef is maar geen ongeluk mag zijn.',
  },
  {
    env: 'INTERRUPT_MIN_WORDS',
    sleutel: 'interruptMinWords',
    standaard: INTERRUPT_MIN_WORDS,
    min: 1,
    max: 10,
    geheel: true,
    waarom:
      'Onder 1 onderbreekt een lege partial; boven 10 wacht je op een hele zin voordat de ' +
      'assistent stopt, en dan praat ze er seconden overheen.',
  },
  {
    env: 'BACKCHANNEL_MAX_MS',
    sleutel: 'backchannelMaxMs',
    standaard: BACKCHANNEL_MAX_MS,
    min: 0,
    max: 10_000,
    geheel: true,
    waarom:
      'Dit is de enige rem die "ja" en "mm-hm" kan tegenhouden. Gemeten komt een bevestiging ' +
      'op ~1570 ms binnen (risico 21), dus de standaard van 400 laat hem nooit aanslaan — ' +
      'hoger zetten is hier de eerste proef die de moeite waard is.',
  },
  {
    env: 'DEEPGRAM_ENDPOINTING_MS',
    sleutel: 'endpointingMs',
    standaard: 300,
    min: 10,
    max: 5_000,
    geheel: true,
    waarom:
      'Bepaalt hoe lang de cliënt stil mag zijn voordat zijn beurt sluit — en dus hoe snel de ' +
      'assistent begint te praten. Te laag knipt midden in een denkpauze (risico 2); te hoog ' +
      'laat elke stilte aanvoelen als een haperende verbinding.',
  },
  {
    env: 'DEEPGRAM_UTTERANCE_END_MS',
    sleutel: 'utteranceEndMs',
    standaard: 1_000,
    min: 1_000,
    max: 5_000,
    geheel: true,
    waarom:
      'Deepgram accepteert onder de 1000 niet. Deze waarde voedt óók de detector voor een te ' +
      'vroege knip (`continuationInterval`), dus hem verhogen verruimt het venster waarin een ' +
      'vervolg nog als afkapping wordt herkend.',
  },
  {
    env: 'ONAFGEROND_WACHT_MS',
    sleutel: 'onafgerondWachtMs',
    standaard: 1_200,
    min: 0,
    max: 5_000,
    geheel: true,
    waarom:
      'Hoe lang de assistent extra zwijgt als de beurt eindigt op een komma of een voegwoord. ' +
      'Anders dan de endpointing kost deze stilte alleen iets op de beurten die er onafgerond ' +
      'uitzien — 12 van de 124 gemeten cliëntuitspraken. 0 zet hem uit, en dat is de stand ' +
      'waarmee je op gehoor kunt vergelijken. Boven de 5 s wordt het wachten zelf een storing: ' +
      'de cliënt denkt dat de verbinding weg is. De juiste waarde is niet uit te rekenen, want ' +
      'stilte en onderbreking zijn in de opgeslagen rijen niet te scheiden (zie onafgerond.ts).',
  },
  {
    env: 'MIC_GATE_RMS',
    sleutel: 'micGateRms',
    standaard: 0.005,
    min: 0,
    max: 0.5,
    geheel: false,
    waarom:
      'De poort in de browser. 0 stuurt alles door, ook de echo van de assistent zelf; boven ' +
      '0,5 komt normale spraak er niet doorheen en hoort de assistent niets meer.',
  },
  {
    env: 'MIC_GATE_CLOSE_MS',
    sleutel: 'micGateCloseMs',
    standaard: 120,
    min: 0,
    max: 2_000,
    geheel: true,
    waarom:
      'Hoe lang het stil moet zijn voordat de poort dichtgaat. Te kort hakt gaten in een zin ' +
      'op de plek van een adempauze; te lang houdt de poort open over de hele stilte heen.',
  },
];

export class DrempelFout extends Error {}

/**
 * Leest de afwijkingen uit de omgeving.
 *
 * Weigert bij onzin, en dat is het punt: een verkeerde stand hoor je pas in een gesprek en niet
 * in een foutmelding. Liever een worker die niet start met een leesbare reden, dan een worker
 * die draait op een waarde die iemand verkeerd heeft ingetypt.
 */
export function leesDrempels(env: Record<string, string | undefined>): Drempels {
  const uit: Record<string, number> = {};
  const klachten: string[] = [];

  for (const regel of REGELS) {
    const rauw = env[regel.env];
    if (rauw === undefined || rauw.trim() === '') {
      uit[regel.sleutel] = regel.standaard;
      continue;
    }

    const n = Number(rauw);
    if (!Number.isFinite(n)) {
      klachten.push(`${regel.env}='${rauw}' is geen getal.`);
      continue;
    }
    if (regel.geheel && !Number.isInteger(n)) {
      klachten.push(`${regel.env}=${rauw} moet een geheel getal zijn.`);
      continue;
    }
    if (n < regel.min || n > regel.max) {
      klachten.push(`${regel.env}=${rauw} valt buiten ${regel.min}–${regel.max}. ${regel.waarom}`);
      continue;
    }
    uit[regel.sleutel] = n;
  }

  if (klachten.length > 0) {
    throw new DrempelFout(
      `Onbruikbare drempelinstelling:\n${klachten.map((k) => `  - ${k}`).join('\n')}\n` +
        'Laat de variabele leeg om de standaardwaarde te gebruiken.',
    );
  }

  return uit as unknown as Drempels;
}

/**
 * De opstartbanner.
 *
 * Elke waarde met een merkteken als hij afwijkt van de standaard. Zonder dat merkteken is
 * achteraf niet te zeggen of een gesprek op de standaard draaide of op een proefstand, en dan
 * is het afstellen zelf niets waard — je weet dan wél wat je hoorde maar niet waarbij.
 */
export function drempelBanner(d: Drempels): string[] {
  return REGELS.map((r) => {
    const waarde = d[r.sleutel];
    const afwijkend = waarde !== r.standaard;
    const merk = afwijkend ? '*' : ' ';
    const staart = afwijkend ? ` (standaard ${r.standaard})` : '';
    return `  ${merk} ${r.env.padEnd(26)} ${String(waarde).padStart(6)}${staart}`;
  });
}

/** Is er iets afgeweken? Voor een korte regel in het log als er niets bijzonders is. */
export function heeftAfwijking(d: Drempels): boolean {
  return REGELS.some((r) => d[r.sleutel] !== r.standaard);
}
