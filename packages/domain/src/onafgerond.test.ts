import { describe, expect, it } from 'vitest';
import { lijktOnafgerond } from './onafgerond';

/**
 * De detector werkt op echte uitspraken uit gevoerde gesprekken.
 *
 * Verzonnen voorbeelden zouden hier weinig waard zijn: het gaat om wat een spraakherkenner
 * werkelijk teruggeeft, inclusief de interpunctie die hij er zelf bij zet.
 */

describe('onafgeronde uitspraken uit echte gesprekken', () => {
  it('herkent een zin die op een komma eindigt', () => {
    // Het gemeten geval van 27 augustus 2026, met endpointing op 700 ms.
    expect(
      lijktOnafgerond(
        'Ik moest bij de grootaandeelhouder van ons bedrijf komen, ik ben directeur,',
      ),
    ).toBe(true);
  });

  it('herkent een zin die op een voegwoord eindigt', () => {
    for (const t of [
      'En weet je van die een beetje van die neven of die',
      'of in die in oorlogsperiode dat dat',
      'Ja, dat',
    ]) {
      expect(lijktOnafgerond(t), t).toBe(true);
    }
  });
});

describe('afgeronde uitspraken uit echte gesprekken', () => {
  it('laat een zin met een punt met rust', () => {
    for (const t of [
      '23 augustus.',
      'Nee, want ik was te veel geschrokken.',
      'Beentje',
      'Ja, ik ben op 23 augustus mondeling op staande voet ontslagen.',
    ]) {
      expect(lijktOnafgerond(t), t).toBe(false);
    }
  });

  it('laat een afsluitend leesteken winnen van het laatste woord', () => {
    /*
     * "dus hij ook." eindigt op een woord dat hangend klinkt, maar de herkenner zette er een
     * punt achter. De eerste versie van deze detector markeerde precies zulke afgeronde zinnen
     * als onafgerond — dat is de fout die deze test vasthoudt.
     */
    expect(lijktOnafgerond('Nee, dat klopt, dus hij ook.')).toBe(false);
    expect(lijktOnafgerond('Waar gaat dat over?')).toBe(false);
  });
});

describe('randgevallen', () => {
  it('zegt niets over een lege uitspraak', () => {
    // Een lege beurt is een ander geval, met een eigen melding. Zie empty_turn.
    expect(lijktOnafgerond('')).toBe(false);
    expect(lijktOnafgerond('   ')).toBe(false);
  });

  it('valt niet om op alleen leestekens', () => {
    expect(lijktOnafgerond('...')).toBe(false);
  });

  it('kijkt naar het laatste woord en niet naar het eerste', () => {
    // "En" aan het begin is normaal spreektaal en zegt niets over het einde.
    expect(lijktOnafgerond('En toen ben ik naar huis gegaan.')).toBe(false);
  });
});

/**
 * Het gat dat de eerste versie liet vallen.
 *
 * De cliënt haalde midden in een zin adem, zonder komma en zonder voegwoord. Van 51
 * cliëntuitspraken uit acht gesprekken eindigde 22% zo — en geen daarvan werd gemarkeerd.
 *
 * Alle uitspraken hieronder zijn letterlijk overgenomen uit `messages`.
 */
describe('kaal afgebroken zinnen', () => {
  it('markeert een zin zonder leesteken die te lang is voor een antwoord', () => {
    for (const t of [
      'in de week was ik op bezoek bij een concurrent om dingen te bespreken en dat heeft mijn compagnon collega gehoord',
      'en die riep zich bij me',
      'Ja, ik ben gisteren mondeling',
    ]) {
      expect(lijktOnafgerond(t), t).toBe(true);
    }
  });

  it('laat korte antwoorden met rust, ook zonder leesteken', () => {
    /*
     * Dit is de helft die het onderscheid draagt. Een werkgeversnaam, een bedrag, een gespelde
     * afkorting: die krijgen van de herkenner net zo goed geen punt, en ze zijn wél af. Zonder
     * deze regel zou de assistent na élk kort antwoord anderhalve seconde zwijgen.
     */
    for (const t of ['Technohub BV', '8500 euro', 'Nee', 'Beentje', 'exclusief', 'R0VC']) {
      expect(lijktOnafgerond(t), t).toBe(false);
    }
  });

  it('laat een lange zin mét punt met rust', () => {
    // Anders bewaakt de lengte niets: een regel die op woorden telt zonder naar het leesteken
    // te kijken, zou driekwart van alle uitspraken markeren.
    expect(
      lijktOnafgerond('Ja, ik ben op 23 augustus mondeling op staande voet ontslagen.'),
    ).toBe(false);
  });
});
