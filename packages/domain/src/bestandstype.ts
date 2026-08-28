/**
 * Wat is dit bestand werkelijk?
 *
 * ## Waarom de extensie niet telt
 *
 * Migratie 0400 zegt het met zoveel woorden: *"Wijkt dit af van `mime_type`, dan is het bestand
 * geweigerd: de extensie is nooit het bewijs (§9)."* Een cliënt die `virus.exe` hernoemt naar
 * `ontslagbrief.pdf` levert een bestand af dat de browser als PDF aankondigt en de bucket als PDF
 * accepteert. Alleen de eerste bytes zeggen wat het is.
 *
 * ## De vier typen
 *
 * Precies de vier uit de CHECK-constraint op `documents.mime_type` en uit `allowed_mime_types`
 * van de bucket. Meer herkennen we niet, en dat is opzet: wat we niet herkennen wordt geweigerd,
 * niet doorgelaten.
 *
 * ## Waarom geen bibliotheek
 *
 * `file-type` kan dit, maar het is een pakket met een eigen afhankelijkheidsboom voor vier typen
 * waarvan er drie een constante van een handvol bytes zijn. Deze repo heeft `check-fantoom-deps`
 * en dependency-cruiser; een afhankelijkheid is hier niet gratis. Zelf geschreven is te testen op
 * échte bestanden in plaats van op nagemaakte bytes, en de DOCX-kant — het enige echte werk —
 * zou een bibliotheek net zo goed moeten doen.
 *
 * ## Wat dit niet is
 *
 * Geen virusscanner en geen inhoudscontrole. Het antwoordt op één vraag: is dit een van de vier
 * typen die we bewaren? Een PDF met kwaadaardige JavaScript erin is nog steeds een PDF.
 */

export type ToegestaanType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'image/jpeg'
  | 'image/png';

export const TOEGESTANE_TYPEN: readonly ToegestaanType[] = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
];

/**
 * Hoeveel bytes de controle nodig heeft.
 *
 * Drie van de vier hebben genoeg aan de eerste acht. De vierde is een ZIP, en daar moeten de
 * namen van de eerste entries voor gelezen worden — die staan vooraan, maar niet op een vaste
 * plek. 64 KB is ruim en houdt het bereikverzoek klein: de bytes hoeven niet door een
 * serverfunctie heen die op 4 MB vastloopt.
 */
export const KOPBYTES = 64 * 1024;

/** Handtekeningen die op zichzelf uitsluitsel geven. */
const HANDTEKENINGEN: readonly { readonly type: ToegestaanType; readonly bytes: number[] }[] = [
  // "%PDF-"
  { type: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  /*
   * JPEG: SOI (FFD8) gevolgd door het begin van de eerste marker (FF).
   *
   * Niet de vierde byte meenemen. Die verschilt per variant — E0 bij JFIF, E1 bij EXIF (wat een
   * telefoon levert), DB bij een kale stroom — en juist de telefoonfoto is het bestand dat we
   * gaan krijgen.
   */
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
];

/** De ZIP-handtekening. Zegt "dit is een zip" en verder niets. */
const ZIP = [0x50, 0x4b, 0x03, 0x04];

function beginMet(kop: Uint8Array, bytes: readonly number[]): boolean {
  if (kop.length < bytes.length) return false;
  return bytes.every((b, i) => kop[i] === b);
}

/**
 * Zoekt een ASCII-string in de kop.
 *
 * Byte voor byte en niet via `TextDecoder`: de rest van een ZIP is binair, en dat door een
 * UTF-8-decoder halen levert vervangingstekens op precies de plekken waar het misgaat.
 */
function bevat(kop: Uint8Array, naald: string): boolean {
  const bytes = [...naald].map((c) => c.charCodeAt(0));
  const grens = kop.length - bytes.length;
  for (let i = 0; i <= grens; i += 1) {
    let raak = true;
    for (let j = 0; j < bytes.length; j += 1) {
      if (kop[i + j] !== bytes[j]) {
        raak = false;
        break;
      }
    }
    if (raak) return true;
  }
  return false;
}

/**
 * Is deze ZIP een Word-document?
 *
 * Een DOCX, een XLSX, een PPTX en een willekeurig zipbestand beginnen met dezelfde vier bytes.
 * Het onderscheid zit in de namen van de entries, en die staan als platte tekst in de local file
 * headers vooraan in het bestand.
 *
 * Twee eisen, en allebei zijn nodig:
 *
 *   `[Content_Types].xml`  elk Open-XML-pakket heeft dit; een gewone zip niet.
 *   `word/`                maakt het een Word-document en geen werkblad (`xl/`) of
 *                          presentatie (`ppt/`).
 *
 * Wat dit niet doet: de ZIP echt uitpakken of de XML valideren. Dat zou het bestand moeten
 * decomprimeren, en dat is werk voor de analysestap — die leest het hele document toch al. Hier
 * gaat het om de vraag of we dit mogen bewaren.
 */
function isWordPakket(kop: Uint8Array): boolean {
  return bevat(kop, '[Content_Types].xml') && bevat(kop, 'word/');
}

export interface Herkenning {
  /** Wat de bytes zeggen dat het is, of `null` als we het niet herkennen. */
  readonly type: ToegestaanType | null;
  /**
   * Waarom er niets herkend is. Alleen gevuld als `type` null is.
   *
   * Bestaat omdat "geweigerd" en "geweigerd omdat het een zip is die geen Word-document is"
   * voor de cliënt verschillende dingen betekenen, en omdat `documents.rejection_reason` hier
   * iets bruikbaars in wil hebben.
   */
  readonly reden?: string;
}

/**
 * Leest het type uit de eerste bytes.
 *
 * `kop` mag korter zijn dan het hele bestand; `KOPBYTES` is genoeg voor alle vier.
 */
export function herkenType(kop: Uint8Array): Herkenning {
  for (const h of HANDTEKENINGEN) {
    if (beginMet(kop, h.bytes)) return { type: h.type };
  }

  if (beginMet(kop, ZIP)) {
    if (isWordPakket(kop)) {
      return { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }
    return {
      type: null,
      reden:
        'Het bestand is een zip-archief maar geen Word-document. Alleen PDF, Word, JPEG en PNG ' +
        'kunnen worden bewaard.',
    };
  }

  return {
    type: null,
    reden: 'Het bestand is geen PDF, Word-document, JPEG of PNG.',
  };
}

/**
 * Komt wat de browser beweert overeen met wat er in het bestand staat?
 *
 * Twee losse antwoorden en niet één booleaan: `documents.detected_type` wil weten wát er is
 * aangetroffen, ook — juist — als het afwijkt van `mime_type`. Een weigering zonder het
 * aangetroffen type laat niemand nagaan wat er is aangeboden.
 */
export function controleerType(
  gemeld: string,
  kop: Uint8Array,
): { readonly ok: boolean; readonly gevonden: ToegestaanType | null; readonly reden?: string } {
  const { type, reden } = herkenType(kop);
  if (type === null) return { ok: false, gevonden: null, ...(reden ? { reden } : {}) };

  if (type !== gemeld) {
    return {
      ok: false,
      gevonden: type,
      /*
       * De cliënt heeft niets fout gedaan en hoort geen beschuldiging te lezen. Een browser die
       * een JPEG als `image/jpg` of als `application/octet-stream` aankondigt, komt hier ook
       * terecht — dat is geen aanval maar een besturingssysteem dat de extensie niet kent.
       */
      reden: 'De inhoud van het bestand komt niet overeen met het opgegeven type.',
    };
  }

  return { ok: true, gevonden: type };
}
