import type { Language } from './enums';

/**
 * "Afgelopen vrijdag" omrekenen naar een datum — deterministisch.
 *
 * ## Waarom dit niet aan het model wordt overgelaten
 *
 * Gemeten met een vast anker (zaterdag 22 augustus 2026) en zes uitdrukkingen door de
 * echte extractie:
 *
 *   gisteren                 2026-08-21  goed
 *   eergisteren              2026-08-20  goed
 *   twee maanden geleden     2026-06-22  goed
 *   drie weken geleden       2026-08-01  goed
 *   afgelopen vrijdag        2026-08-18  FOUT (moest 2026-08-21 zijn)
 *   vorige week maandag      2026-08-18  FOUT (moest 2026-08-10 zijn)
 *
 * Zuivere offsets gaan goed; zodra er een weekdagnaam bij komt, gaat het mis — en het
 * levert twee keer dezelfde verkeerde datum op, dus het is geen toeval. Een verkeerde
 * ontslagdatum is in dit dossier erger dan een ontbrekende: hij is niet van een juiste te
 * onderscheiden en er wordt een vervaltermijn op gerekend.
 *
 * Dezelfde redenering als bij `findArithmeticClaim`: twaalf maal twaalfduizend is
 * honderdvierenveertigduizend ongeacht wat een model ervan vindt, en de vrijdag vóór
 * zaterdag 22 augustus is de 21e. Dat hoort niet gevraagd te worden maar berekend.
 *
 * ## Wat hier niet in zit
 *
 * Offsets ("twee maanden geleden") en losse datums ("3 maart"). Die gaan goed, en er een
 * tweede implementatie naast zetten zou betekenen dat twee stukken code het oneens kunnen
 * worden over dezelfde zin.
 */

/** Maandag = 1 … zondag = 7, zoals ISO 8601. */
export type WeekdagIndex = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const WEEKDAGEN: Record<Language, readonly string[]> = {
  nl: ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'],
  en: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
};

/**
 * Hoe de cliënt naar die weekdag verwees.
 *
 * - `recentste`: de laatste keer dat het die dag was, vóór vandaag. "Afgelopen vrijdag",
 *   "vorige vrijdag", of kaal "vrijdag" in een zin over het verleden.
 * - `vorigeWeek`: die dag in de vorige kalenderweek. "Vorige week maandag" is iets anders
 *   dan "afgelopen maandag" zodra vandaag later in de week valt dan die maandag — dat
 *   verschil is een hele week, en in een vervaltermijn telt dat.
 */
export type WeekdagRichting = 'recentste' | 'vorigeWeek';

export interface WeekdagVerwijzing {
  readonly weekdag: WeekdagIndex;
  readonly richting: WeekdagRichting;
  /** Het stuk tekst dat is herkend; voor de logregel en om te kunnen nazoeken. */
  readonly gevonden: string;
}

/**
 * Zoekt een weekdagverwijzing in een uitspraak.
 *
 * Geeft `null` als er geen weekdag in staat, of als er een expliciete datum bij staat —
 * "vrijdag 21 augustus" heeft geen berekening nodig en dan hoort dit vangnet zich er niet
 * mee te bemoeien.
 */
export function vindWeekdagVerwijzing(
  tekst: string,
  language: Language = 'nl',
): WeekdagVerwijzing | null {
  const laag = tekst.toLowerCase();
  const dagen = WEEKDAGEN[language];

  for (let i = 0; i < dagen.length; i += 1) {
    const dag = dagen[i];
    if (!dag) continue;
    const positie = laag.indexOf(dag);
    if (positie === -1) continue;

    // Staat er een getal vlak achter de dagnaam, dan noemde de cliënt een datum
    // ("vrijdag 21 augustus") en is er niets uit te rekenen.
    const staart = laag.slice(positie + dag.length, positie + dag.length + 14);
    if (/^\s*\d/.test(staart)) return null;

    const kop = laag.slice(Math.max(0, positie - 24), positie);
    const vorigeWeek =
      language === 'nl' ? /vorige\s+week\s*$/.test(kop) : /last\s+week\s*$/.test(kop);

    return {
      weekdag: (i + 1) as WeekdagIndex,
      richting: vorigeWeek ? 'vorigeWeek' : 'recentste',
      gevonden: tekst.slice(Math.max(0, positie - 24), positie + dag.length).trim(),
    };
  }
  return null;
}

/** Dagen sinds 1970 uit een ISO-datum; kalenderrekenwerk zonder tijdzonevalkuilen. */
function dagnummer(iso: string): number {
  const delen = iso.split('-').map(Number);
  const [jaar, maand, dag] = delen;
  if (jaar === undefined || maand === undefined || dag === undefined) {
    throw new Error(`Geen geldige ISO-datum: ${iso}`);
  }
  return Math.floor(Date.UTC(jaar, maand - 1, dag) / 86_400_000);
}

function naarIso(dagen: number): string {
  return new Date(dagen * 86_400_000).toISOString().slice(0, 10);
}

/**
 * De datum waar een weekdagverwijzing op uitkomt.
 *
 * `ankerIso` is vandaag in de zone van het kantoor, `ankerWeekdag` de bijbehorende
 * ISO-weekdag. Beide komen uit hetzelfde anker dat ook in de prompt staat, zodat de
 * berekening en de instructie niet uit elkaar kunnen lopen.
 */
export function resolveWeekdag(
  ankerIso: string,
  ankerWeekdag: WeekdagIndex,
  verwijzing: WeekdagVerwijzing,
): string {
  const vandaag = dagnummer(ankerIso);

  if (verwijzing.richting === 'vorigeWeek') {
    // Maandag van deze week, dan zeven dagen terug, dan naar de gevraagde dag.
    const maandagDezeWeek = vandaag - (ankerWeekdag - 1);
    return naarIso(maandagDezeWeek - 7 + (verwijzing.weekdag - 1));
  }

  // De laatste keer dat het die dag was, strikt vóór vandaag. Is het vandaag die dag,
  // dan bedoelt "afgelopen vrijdag" een week geleden en niet vandaag.
  let terug = ankerWeekdag - verwijzing.weekdag;
  if (terug <= 0) terug += 7;
  return naarIso(vandaag - terug);
}
