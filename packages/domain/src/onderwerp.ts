import { isConfirmed, type CaseFactMap } from './schemas/case-fact';

/**
 * Het onderwerp van een intake, afgeleid uit de vastgelegde feiten.
 *
 * ## Waarom een regel en geen model
 *
 * `intakes.subject` staat op het dashboard: het is de kolom waarop een advocaat in één oogopslag
 * kiest wat hij opent. Een onderwerp dat uit een model komt, is op die plek een bewering zonder
 * citaat. Uit de feiten afleiden is herleidbaar en na te rekenen — dezelfde redenering als bij de
 * erkenning en het wanhoodspad: het model beslist niets over de woorden.
 *
 * Zie RISICOS.md risico 24 voor de afweging en voor wat er eerst stond (niets — de kolom bleef
 * leeg omdat er geen bron voor was).
 *
 * ## Waar de woorden vandaan komen
 *
 * `termination_route` is de kop, want die noemt de juridische route. `primary_issue` is de
 * terugval als de route nog niet vaststaat of niets noemt (`none_yet`, `other`).
 *
 * Beide zijn `required` in de catalogus met de hoogste prioriteiten (100 en 95): dit zijn de
 * eerste twee dingen die een intake vaststelt, niet iets wat er toevallig soms bij zit. In alle
 * vier de gevoerde gesprekken met inhoud stonden ze er allebei, `confirmed`.
 *
 * ## Alleen `confirmed`
 *
 * Niet `inferred`. Dat is een gevolgtrekking van het model, en voor een kolom waarop een advocaat
 * zijn werkvoorraad sorteert is dat te zwak. Niet `contradicted`, om de voor de hand liggende
 * reden. Niet `unknown`, want daar is geen waarde.
 *
 * ## Leeg blijft leeg
 *
 * `null` als er niets uit te leiden valt. Een streepje op het dashboard is eerlijk; een gegokt
 * onderwerp is dat niet. Vroeg in een gesprek hoort er dus niets te staan, en dat is geen gebrek.
 *
 * ## Wat hier niet is getoetst
 *
 * De tabel dekt negen routes. Eén ervan — `summary_dismissal` — is tegen echte gesprekken
 * gecontroleerd; de andere acht zijn redenering over de catalogus. De eerste intake met een
 * ander scenario (een vaststellingsovereenkomst, een UWV-procedure) is meteen de moeite waard om
 * na te kijken.
 */

/** Het afgeleide onderwerp, met de feiten waar het op rust. */
export interface Onderwerp {
  /** De tekst zoals hij in `intakes.subject` komt. */
  readonly tekst: string;
  /**
   * De feitsleutels waaruit deze tekst volgt.
   *
   * Staat erbij zodat een advocaat kan zien waaróp het onderwerp rust, en zodat een verouderd
   * onderwerp herkenbaar is: raakt een van deze feiten later `contradicted`, dan klopt de tekst
   * niet meer. De RPC doet `coalesce(p_subject, subject)` en kan een onderwerp dus nooit meer
   * leegmaken — zonder deze lijst is dat van buiten niet te zien.
   */
  readonly bronnen: readonly string[];
}

/**
 * De kop: hoe het dienstverband eindigt of eindigde.
 *
 * `none_yet` en `other` staan er bewust niet in. Ze zijn geldige antwoorden — de werkgever heeft
 * nog geen route gekozen — maar ze noemen niets, en "Nog geen route" is geen onderwerp. Dan wint
 * de terugval.
 */
const ROUTE_TEKST: Readonly<Record<string, string>> = {
  summary_dismissal: 'Ontslag op staande voet',
  settlement_agreement: 'Vaststellingsovereenkomst',
  uwv_procedure: 'Ontslagprocedure UWV',
  court_dissolution: 'Ontbinding via de kantonrechter',
  probation_dismissal: 'Ontslag in de proeftijd',
  fixed_term_expiry: 'Einde tijdelijk contract',
  resignation: 'Ontslagname door de werknemer',
};

/**
 * De terugval: waar het volgens de cliënt over gaat.
 *
 * Grover dan de route — "Ontslag" tegen "Ontslag op staande voet" — en dat hoort ook: zolang de
 * route niet vaststaat, is grover het eerlijke antwoord.
 */
const ISSUE_TEKST: Readonly<Record<string, string>> = {
  dismissal: 'Ontslag',
  settlement_agreement: 'Vaststellingsovereenkomst',
  wage: 'Loonvordering',
  illness: 'Ziekte en re-integratie',
  conflict: 'Arbeidsconflict',
  non_compete: 'Concurrentiebeding',
};

/**
 * Een bijzin achter de kop.
 *
 * ## Waarom er precies één is
 *
 * Een lijstkolom wordt gelezen in een oogopslag; vier bijzinnen vullen hem en zeggen niets. De
 * toets is niet "is dit waar" maar **verandert dit wat een advocaat als eerste doet**.
 *
 * `currently_ill` haalt die toets: bij opzegging tijdens ziekte speelt een opzegverbod, en dat is
 * juridisch een ander dossier. `summary_dismissal_contested` haalt hem niet — bij een intake is
 * dat bijna altijd waar, en wat overal staat onderscheidt niets.
 *
 * ## Er kan er later een bij
 *
 * De lijst is geordend: de eerste die aanslaat wint, er komt er nooit meer dan één achter de kop.
 * Een regel toevoegen is een regel in deze tabel, met `waarom` ingevuld. Dat veld is verplicht en
 * dat is de bedoeling: het dwingt de vraag "verandert dit wat iemand als eerste doet" af te
 * beantwoorden vóórdat de kolom voller wordt.
 */
interface Bijzin {
  /** Het feit dat hem aanzet. */
  readonly sleutel: string;
  /** Wanneer telt de waarde? Alleen aangeroepen als het feit `confirmed` is. */
  readonly wanneer: (waarde: unknown) => boolean;
  /** Wat er achter de komma komt. */
  readonly tekst: string;
  /** Waarom deze bijzin verandert wat een advocaat als eerste doet. Verplicht. */
  readonly waarom: string;
}

export const BIJZINNEN: readonly Bijzin[] = [
  {
    sleutel: 'currently_ill',
    wanneer: (waarde) => waarde === true,
    tekst: 'tijdens ziekte',
    waarom:
      'Bij opzegging tijdens ziekte geldt een opzegverbod (art. 7:670 BW). Dat maakt het een ' +
      'ander dossier met een andere eerste stap, en zonder deze bijzin is dat op het dashboard ' +
      'niet te zien — "Ontslag op staande voet" verzwijgt het volledig.',
  },
];

/** Hoeveel tekens een lijstkolom aankan voordat hij afkapt. */
const MAX_TEKENS = 40;

/** De waarde van een feit, maar alleen als het `confirmed` is. */
function bevestigdeWaarde(feiten: CaseFactMap, sleutel: string): unknown {
  const feit = feiten[sleutel];
  return isConfirmed(feit) ? feit?.value : undefined;
}

/**
 * Stelt het onderwerp samen uit de vastgelegde feiten.
 *
 * Zuiver: geen klok, geen omgeving, geen database. Dezelfde feiten geven altijd dezelfde tekst,
 * en dat is wat "herleidbaar" hier betekent — een advocaat kan het narekenen.
 */
export function onderwerpVan(feiten: CaseFactMap): Onderwerp | null {
  const bronnen: string[] = [];

  const route = bevestigdeWaarde(feiten, 'termination_route');
  const issue = bevestigdeWaarde(feiten, 'primary_issue');

  let kop: string | undefined;
  if (typeof route === 'string' && ROUTE_TEKST[route] !== undefined) {
    kop = ROUTE_TEKST[route];
    bronnen.push('termination_route');
  } else if (typeof issue === 'string' && ISSUE_TEKST[issue] !== undefined) {
    kop = ISSUE_TEKST[issue];
    bronnen.push('primary_issue');
  }

  // Geen kop, geen onderwerp. Een bijzin zonder kop ("tijdens ziekte") is geen onderwerp maar
  // een losse mededeling, en die hoort niet in een kolom waarop iemand sorteert.
  if (kop === undefined) return null;

  for (const bijzin of BIJZINNEN) {
    const waarde = bevestigdeWaarde(feiten, bijzin.sleutel);
    if (waarde === undefined || !bijzin.wanneer(waarde)) continue;

    const samen = `${kop}, ${bijzin.tekst}`;
    // Liever de bijzin laten vallen dan de kop afkappen: "Ontslagprocedure UWV, tijdens zi…"
    // leest slechter dan "Ontslagprocedure UWV" en zegt niet meer.
    if (samen.length <= MAX_TEKENS) {
      kop = samen;
      bronnen.push(bijzin.sleutel);
    }
    break;
  }

  return { tekst: kop, bronnen };
}

/**
 * Klopt een opgeslagen onderwerp nog met de feiten van vandaag?
 *
 * Bestaat omdat `agent_update_progress` het onderwerp bijwerkt met
 * `coalesce(p_subject, subject)`: het kan scherper worden, maar nooit meer terug naar leeg. Raakt
 * `termination_route` later `contradicted`, dan blijft "Ontslag op staande voet" staan terwijl er
 * niets meer onder ligt.
 *
 * Dat is geen reden voor een migratie — een verouderd onderwerp en een leeg onderwerp zijn
 * allebei fout, dus daar ruil je niets mee in. Wel een reden om het zíchtbaar te maken op de
 * plek waar de feiten toch al op tafel liggen: het dossier.
 *
 * `null` als er niets te melden is. Anders het onderwerp dat er nú uit zou komen — dat kan ook
 * `null` zijn, en dan is dat het antwoord: er ligt niets meer onder.
 */
export function onderwerpVerouderd(
  opgeslagen: string | null,
  feiten: CaseFactMap,
): { readonly nu: Onderwerp | null } | null {
  if (opgeslagen === null || opgeslagen.trim() === '') return null;
  const nu = onderwerpVan(feiten);
  if (nu !== null && nu.tekst === opgeslagen) return null;
  return { nu };
}
