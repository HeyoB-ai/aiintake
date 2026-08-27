import { describe, expect, it } from 'vitest';
import { EMPLOYMENT_CATALOG } from './employment';

/**
 * De assistent mag niet beloven wat het systeem niet kan.
 *
 * ## Wat er gebeurde
 *
 * De assistent vroeg een cliënt of hij zijn ontslagbrief kon uploaden. Dat kan niet: er is een
 * bucket, een tabel en een knop, maar geen enkele regel code die een bestand van een cliënt
 * naar opslag schrijft. Zie RISICOS.md risico 22.
 *
 * De bron was geen prompt maar deze catalogus. `has_employment_contract` had als hint
 * *"Heeft de cliënt de arbeidsovereenkomst bij de hand om te uploaden?"*, en die hint gaat als
 * kandidaatvraag naar het model. Het woord kwam dus letterlijk uit de code.
 *
 * ## Waarom een test en niet alleen een gewijzigde hint
 *
 * Omdat de volgende hint net zo makkelijk wordt geschreven. Een catalogus groeit, en "kunt u
 * dat opsturen?" is een natuurlijke formulering voor iemand die niet weet dat uploaden nog niet
 * bestaat. Deze test is het geheugen daarvoor.
 *
 * ## Wanneer deze test weg mag
 *
 * Zodra er een werkende weg is waarlangs een cliënt een bestand aanlevert — fase 4 van de
 * roadmap. Dan is de belofte waar te maken en hoort dit verbod te verdwijnen, niet omzeild te
 * worden. Wie hem eerder weghaalt, haalt de reden weg en niet het probleem.
 */

/*
 * Alleen woorden die een handeling van de cliënt vragen.
 *
 * "document" en "brief" staan er bewust niet in: dat zijn zelfstandige naamwoorden en de
 * assistent mág naar de inhoud van een stuk vragen. Verboden is de toezegging dat wij het
 * kunnen ontvangen.
 */
const BELOFTEWOORDEN = [
  'upload',
  'uploaden',
  'opsturen',
  'toesturen',
  'insturen',
  'aanleveren',
  'mailen',
  'doorsturen',
  'delen',
];

describe('geen uploadbelofte in de feitcatalogus', () => {
  const velden = EMPLOYMENT_CATALOG.facts.flatMap((f) => [
    { waar: `${f.key}.hint.nl`, tekst: f.hint?.nl ?? '' },
    { waar: `${f.key}.hint.en`, tekst: f.hint?.en ?? '' },
    { waar: `${f.key}.label.nl`, tekst: f.label.nl },
    { waar: `${f.key}.label.en`, tekst: f.label.en },
  ]);

  it('vraagt de cliënt nergens om een bestand aan te leveren', () => {
    const overtreders = velden.filter((v) =>
      BELOFTEWOORDEN.some((w) => new RegExp(`\\b${w}`, 'i').test(v.tekst)),
    );
    expect(
      overtreders.map((o) => `${o.waar}: "${o.tekst}"`),
      'Deze teksten gaan als kandidaatvraag naar het model. Uploaden bestaat nog niet ' +
        '(RISICOS.md risico 22), dus een vraag die erom vraagt levert een belofte op die het ' +
        'systeem niet waarmaakt. Vraag naar de inhoud van het stuk, niet naar het stuk.',
    ).toEqual([]);
  });

  it('kan wel falen — de detector werkt', () => {
    // Zonder deze regel is "nul overtreders" niet te onderscheiden van een test die niets
    // aanraakt. Dat is deze week vaker voorgekomen dan me lief is.
    const nep = 'Kunt u de arbeidsovereenkomst uploaden?';
    expect(BELOFTEWOORDEN.some((w) => new RegExp(`\\b${w}`, 'i').test(nep))).toBe(true);
  });

  it('houdt de documentcategorie zelf overeind', () => {
    // Het verbod gaat over de toezegging, niet over het onderwerp. Dát iemand zijn contract
    // heeft, is bruikbaar voor de advocaat en hoort gevraagd te blijven worden.
    const documentFeiten = EMPLOYMENT_CATALOG.facts.filter((f) => f.category === 'documents');
    expect(documentFeiten.length).toBeGreaterThan(0);
  });
});
