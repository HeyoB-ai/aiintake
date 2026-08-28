import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOPBYTES, controleerType, herkenType } from './bestandstype';

/**
 * Echte bestanden, geen nagemaakte bytes.
 *
 * De handtekeningen zelf overtypen uit de documentatie en daar dan tegenaan testen, bewijst
 * alleen dat ik twee keer hetzelfde heb opgeschreven. In `__fixtures__` staan daarom bestanden
 * die door een ander programma zijn gemaakt: de PNG en de JPEG door System.Drawing, de DOCX en
 * de XLSX door een echte zipper. Wat daar uitkomt, is wat een cliënt ook aanlevert.
 *
 * Twee tegenvoorbeelden horen erbij en zijn het echte werk:
 *
 *   `werkblad-geen-word.xlsx`   begint met dezelfde vier bytes als een DOCX
 *   `hernoemd-uitvoerbaar.pdf`  heet .pdf en is het niet
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const lees = (naam: string): Uint8Array =>
  new Uint8Array(readFileSync(join(HIER, '__fixtures__', naam)));

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('de vier typen die we bewaren', () => {
  it('herkent een echte PDF', () => {
    expect(herkenType(lees('echt.pdf')).type).toBe('application/pdf');
  });

  it('herkent een echte PNG', () => {
    expect(herkenType(lees('echt.png')).type).toBe('image/png');
  });

  it('herkent een echte JPEG', () => {
    expect(herkenType(lees('echt.jpg')).type).toBe('image/jpeg');
  });

  it('herkent een echt Word-document', () => {
    expect(herkenType(lees('echt.docx')).type).toBe(DOCX);
  });
});

describe('een zip is nog geen Word-document', () => {
  it('weigert een werkblad dat met dezelfde vier bytes begint', () => {
    /*
     * Dit is de reden dat de ZIP-handtekening alleen niet volstaat. Een XLSX, een PPTX en een
     * willekeurig archief openen identiek; alleen de namen van de entries verschillen.
     */
    const uitkomst = herkenType(lees('werkblad-geen-word.xlsx'));
    expect(uitkomst.type).toBeNull();
    expect(uitkomst.reden).toContain('zip-archief');
  });

  it('noemt de vier bytes van een zip niet als bewijs', () => {
    // Kale zip-handtekening, verder niets. Zonder de entrynamen valt er niets te concluderen.
    const kaal = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    expect(herkenType(kaal).type).toBeNull();
  });

  it('weigert een archief met backslashes in de padnamen', () => {
    /*
     * Dit randgeval is niet bedacht maar tegengekomen. De eerste fixture is gemaakt met
     * `Compress-Archive` uit Windows PowerShell 5.1, en die schrijft `word\document.xml` — met
     * een backslash, in strijd met de zip-spec (APPNOTE 4.4.17.1 schrijft een forward slash
     * voor). De test viel er meteen over.
     *
     * Het blijft een weigering. Word, LibreOffice en Google Docs leveren allemaal forward
     * slashes; een archief dat dat niet doet, is geen document dat wij van een cliënt
     * verwachten. Liever een geweigerd raar bestand dan een soepele controle.
     */
    expect(herkenType(lees('zip-met-backslashes.docx')).type).toBeNull();
  });
});

describe('de extensie is nooit het bewijs', () => {
  it('weigert een uitvoerbaar bestand dat .pdf heet', () => {
    // MZ-header: een Windows-executable. De naam zegt pdf, de bytes zeggen iets anders.
    const uitkomst = controleerType('application/pdf', lees('hernoemd-uitvoerbaar.pdf'));
    expect(uitkomst.ok).toBe(false);
    expect(uitkomst.gevonden).toBeNull();
  });

  it('weigert een echte PNG die als PDF wordt aangekondigd', () => {
    /*
     * Hier is het bestand op zichzelf prima, maar de bewering klopt niet. `gevonden` moet dan wél
     * gevuld zijn: `documents.detected_type` wil weten wát er is aangetroffen, juist als het
     * afwijkt. Een weigering zonder dat gegeven laat niemand nagaan wat er is aangeboden.
     */
    const uitkomst = controleerType('application/pdf', lees('echt.png'));
    expect(uitkomst.ok).toBe(false);
    expect(uitkomst.gevonden).toBe('image/png');
  });

  it('laat door wat klopt', () => {
    // Anders bewaakt de test hierboven niets: een controle die alles weigert, zou ook slagen.
    expect(controleerType('image/png', lees('echt.png')).ok).toBe(true);
    expect(controleerType(DOCX, lees('echt.docx')).ok).toBe(true);
  });
});

describe('randgevallen', () => {
  it('valt niet om op een leeg bestand', () => {
    expect(herkenType(new Uint8Array(0)).type).toBeNull();
  });

  it('valt niet om op minder bytes dan een handtekening lang is', () => {
    // Een afgebroken upload levert precies dit op.
    expect(herkenType(new Uint8Array([0x89, 0x50])).type).toBeNull();
  });

  it('leest niet verder dan de kop die het krijgt', () => {
    /*
     * Het bereikverzoek haalt `KOPBYTES` op en niet het hele bestand — 20 MB door een
     * serverfunctie halen is precies wat weg B vermijdt. Een DOCX waarvan `word/` pas ná die
     * grens zou staan, wordt dus geweigerd, en dat is beter dan hem ongezien doorlaten.
     */
    const docx = lees('echt.docx');
    expect(docx.length).toBeLessThan(KOPBYTES);
    expect(herkenType(docx.slice(0, 8)).type).toBeNull();
  });
});
