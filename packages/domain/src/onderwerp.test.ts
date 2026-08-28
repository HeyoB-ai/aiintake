import { describe, expect, it } from 'vitest';
import { BIJZINNEN, onderwerpVan, onderwerpVerouderd } from './onderwerp';
import type { CaseFact, CaseFactMap } from './schemas/case-fact';

/**
 * De vier gesprekken in deze tests zijn echt gevoerd.
 *
 * De feiten hieronder zijn overgenomen uit `case_facts` van 27 augustus 2026, inclusief de
 * statussen. Verzonnen feiten zouden hier weinig waard zijn: het gaat erom of de regel werkt op
 * wat de extractie werkelijk oplevert — enum-sleutels als `"summary_dismissal"`, niet Nederlandse
 * vrije tekst.
 *
 * Wat deze tests dus wél aantonen: de tak `summary_dismissal` klopt tegen de werkelijkheid. Wat
 * ze niet aantonen: de andere acht routes. Daar is nog geen gesprek voor gevoerd, en dat staat
 * ook in onderwerp.ts.
 */

function feit(value: unknown, status: CaseFact['status'] = 'confirmed'): CaseFact {
  return {
    key: 'x',
    value,
    valueType: typeof value === 'boolean' ? 'boolean' : 'enum',
    status,
    confidence: status === 'confirmed' ? 0.9 : 0,
    source: 'client_statement',
    sourceRef: 'msg-1',
    llmCallId: null,
  };
}

const map = (feiten: Record<string, CaseFact>): CaseFactMap => feiten;

describe('de gesprekken van 27 augustus', () => {
  it('levert "Ontslag op staande voet" voor het gesprek van 19:05', () => {
    // beurten=4 · primary_issue "dismissal" · termination_route "summary_dismissal"
    const onderwerp = onderwerpVan(
      map({
        primary_issue: feit('dismissal'),
        termination_route: feit('summary_dismissal'),
        summary_dismissal_date: feit('2026-08-26'),
        job_title: feit('directeur'),
      }),
    );

    expect(onderwerp?.tekst).toBe('Ontslag op staande voet');
    expect(onderwerp?.bronnen).toEqual(['termination_route']);
  });

  it('zet de bijzin erachter voor het gesprek van 20:53', () => {
    /*
     * Hetzelfde ontslag, maar `currently_ill` staat er. Dat is precies het geval waarvoor de
     * bijzin bestaat: er speelt een opzegverbod, en "Ontslag op staande voet" alleen verzwijgt
     * dat volledig.
     */
    const onderwerp = onderwerpVan(
      map({
        primary_issue: feit('dismissal'),
        termination_route: feit('summary_dismissal'),
        workplace_conflict: feit(true),
        currently_ill: feit(true),
        summary_dismissal_contested: feit(true),
      }),
    );

    expect(onderwerp?.tekst).toBe('Ontslag op staande voet, tijdens ziekte');
    expect(onderwerp?.bronnen).toEqual(['termination_route', 'currently_ill']);
  });

  it('laat "betwist" en het arbeidsconflict er bewust buiten', () => {
    // Beide stonden in het gesprek van 20:53 op true. Eén bijzin, en alleen die er een verschil
    // maakt in wat een advocaat als eerste doet.
    const onderwerp = onderwerpVan(
      map({
        termination_route: feit('summary_dismissal'),
        summary_dismissal_contested: feit(true),
        workplace_conflict: feit(true),
      }),
    );

    expect(onderwerp?.tekst).toBe('Ontslag op staande voet');
  });

  it('geeft niets voor het gesprek van 16:10, dat één beurt duurde', () => {
    expect(onderwerpVan(map({}))).toBeNull();
  });
});

describe('de kop', () => {
  it('laat de route winnen van de kern', () => {
    // "Ontslag" is niet fout, maar het is grover dan wat we weten.
    const onderwerp = onderwerpVan(
      map({ primary_issue: feit('dismissal'), termination_route: feit('uwv_procedure') }),
    );
    expect(onderwerp?.tekst).toBe('Ontslagprocedure UWV');
  });

  it('valt terug op de kern zolang de route nog niets noemt', () => {
    /*
     * Dit is het meebewegen: eerst staat alleen `primary_issue` vast en is "Ontslag" het eerlijke
     * antwoord; komt de route erbij, dan wordt het scherper. Grof is hier geen gebrek.
     */
    for (const route of ['none_yet', 'other']) {
      const onderwerp = onderwerpVan(
        map({ primary_issue: feit('dismissal'), termination_route: feit(route) }),
      );
      expect(onderwerp?.tekst, route).toBe('Ontslag');
      expect(onderwerp?.bronnen, route).toEqual(['primary_issue']);
    }
  });

  it('valt ook terug als de route er nog helemaal niet is', () => {
    expect(onderwerpVan(map({ primary_issue: feit('wage') }))?.tekst).toBe('Loonvordering');
  });

  it('geeft niets als beide niets noemen', () => {
    // De enige combinatie waarin er echt niets uit komt. Leeg blijft leeg.
    expect(onderwerpVan(map({ primary_issue: feit('other'), termination_route: feit('other') })))
      .toBeNull();
  });
});

describe('alleen vastgestelde feiten', () => {
  it('gebruikt een inferred route niet', () => {
    /*
     * `inferred` is een gevolgtrekking van het model. Voor de kolom waarop een advocaat zijn
     * werkvoorraad sorteert is dat te zwak — dan liever de grovere kern, die wél vaststaat.
     */
    const onderwerp = onderwerpVan(
      map({
        primary_issue: feit('dismissal'),
        termination_route: feit('summary_dismissal', 'inferred'),
      }),
    );
    expect(onderwerp?.tekst).toBe('Ontslag');
  });

  it('gebruikt een contradicted route niet', () => {
    const onderwerp = onderwerpVan(
      map({ termination_route: feit('summary_dismissal', 'contradicted') }),
    );
    expect(onderwerp).toBeNull();
  });

  it('gebruikt een unknown feit niet', () => {
    // `unknown` betekent "gevraagd, geen antwoord". Er is geen waarde om te vertalen.
    expect(onderwerpVan(map({ termination_route: feit(null, 'unknown') }))).toBeNull();
  });

  it('zet geen bijzin achter een niet-vastgestelde ziekte', () => {
    const onderwerp = onderwerpVan(
      map({ termination_route: feit('summary_dismissal'), currently_ill: feit(true, 'inferred') }),
    );
    expect(onderwerp?.tekst).toBe('Ontslag op staande voet');
  });

  it('zet geen bijzin bij currently_ill = false', () => {
    // Anders bewaakt de test hierboven niets: een bijzin die altijd aanslaat zou ook slagen.
    const onderwerp = onderwerpVan(
      map({ termination_route: feit('summary_dismissal'), currently_ill: feit(false) }),
    );
    expect(onderwerp?.tekst).toBe('Ontslag op staande voet');
  });
});

describe('de vorm van de tabel', () => {
  it('past in een lijstkolom', () => {
    /*
     * Elke kop, met de langste bijzin erachter. Wat niet past hoort de bijzin te laten vallen en
     * niet de kop af te kappen — "Ontslagprocedure UWV, tijdens zi…" leest slechter dan de kop
     * alleen en zegt niet meer.
     */
    const routes = [
      'summary_dismissal',
      'settlement_agreement',
      'uwv_procedure',
      'court_dissolution',
      'probation_dismissal',
      'fixed_term_expiry',
      'resignation',
    ];
    for (const route of routes) {
      const tekst = onderwerpVan(
        map({ termination_route: feit(route), currently_ill: feit(true) }),
      )?.tekst;
      expect(tekst, route).toBeDefined();
      expect(tekst!.length, `${route}: "${tekst!}"`).toBeLessThanOrEqual(40);
      expect(tekst, route).not.toContain('…');
    }
  });

  it('elke bijzin zegt waarom hij er staat', () => {
    // Verplicht veld, en dat is het punt: het dwingt de vraag "verandert dit wat een advocaat
    // als eerste doet" af te beantwoorden vóórdat de kolom voller wordt.
    for (const b of BIJZINNEN) {
      expect(b.waarom.trim().length, b.sleutel).toBeGreaterThan(40);
    }
  });
});

describe('een verouderd onderwerp is herkenbaar', () => {
  it('meldt niets zolang het onderwerp nog volgt uit de feiten', () => {
    const feiten = map({ termination_route: feit('summary_dismissal') });
    expect(onderwerpVerouderd('Ontslag op staande voet', feiten)).toBeNull();
  });

  it('meldt het zodra het bronfeit contradicted is geraakt', () => {
    /*
     * Dit is het geval dat `coalesce(p_subject, subject)` in de RPC onzichtbaar maakt: het
     * onderwerp kan scherper worden maar nooit meer terug naar leeg. Zonder deze controle blijft
     * "Ontslag op staande voet" op het dashboard staan terwijl er niets meer onder ligt.
     */
    const feiten = map({ termination_route: feit('summary_dismissal', 'contradicted') });
    expect(onderwerpVerouderd('Ontslag op staande voet', feiten)).toEqual({ nu: null });
  });

  it('meldt het ook als de feiten inmiddels iets anders zeggen', () => {
    const feiten = map({ termination_route: feit('settlement_agreement') });
    const uitkomst = onderwerpVerouderd('Ontslag op staande voet', feiten);
    expect(uitkomst?.nu?.tekst).toBe('Vaststellingsovereenkomst');
  });

  it('zegt niets over een intake zonder onderwerp', () => {
    // Leeg is geen verouderd onderwerp; daar valt niets aan te melden.
    expect(onderwerpVerouderd(null, map({}))).toBeNull();
    expect(onderwerpVerouderd('   ', map({}))).toBeNull();
  });
});
