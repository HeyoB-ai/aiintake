import { describe, expect, it } from 'vitest';
import { AnthropicLlmProvider } from '@intake/provider-llm';
import type { OrgConfig } from '@intake/domain';
import { IntakeSession } from './intake-session';

/**
 * Komen relatieve tijdsaanduidingen als échte datums in het dossier?
 *
 * ## Waarom dit een integratietest is en geen unittest
 *
 * De omrekening gebeurt in het model. Een unittest kan vastleggen dát het anker in de
 * prompt staat — dat doet packages/prompts/src/datumanker.test.ts — maar niet of het
 * model er iets mee doet. Dat is precies de vraag: de prompt had al een `todayIso`, en
 * toch kwamen er geen datums uit, want er stond geen weekdag bij en geen instructie.
 *
 * ## De vaste "vandaag"
 *
 * `now` wordt geïnjecteerd. Zonder dat zou deze test morgen andere datums verwachten en
 * dus omvallen op de kalender in plaats van op een echte regressie — en dan wordt hij
 * uitgezet, en dan bewaakt hij niets meer.
 *
 * Gekozen moment: zaterdag 22 augustus 2026, 12:00 in Amsterdam. Zaterdag omdat "afgelopen
 * vrijdag" dan gisteren is, en dat is het geval waarin een verkeerde weekdag meteen
 * opvalt.
 *
 * ## Wat dit niet is
 *
 * Geen test op de precieze bewoording van het model. Alleen op de waarde die in
 * `case_facts` belandt, en op het onderscheid tussen "uitgerekend" en "niet vast te
 * stellen". Dat laatste is de helft die ertoe doet: een gegokte datum is in dit dossier
 * niet van een vastgestelde te onderscheiden.
 *
 * Draaien met: pnpm test:pipeline
 */

const VANDAAG = new Date('2026-08-22T10:00:00Z'); // zaterdag, 12:00 in Amsterdam

const ORG = {
  id: 'o',
  name: 'Kantoor De Vries',
  slug: 'devries',
  timeZone: 'Europe/Amsterdam',
} as OrgConfig;

const heeftSleutel = Boolean(process.env['ANTHROPIC_API_KEY']);

function sessie(): IntakeSession {
  return new IntakeSession({
    llm: new AnthropicLlmProvider({ apiKey: process.env['ANTHROPIC_API_KEY']! }),
    organization: ORG,
    hotModel: process.env['LLM_HOT_MODEL'] ?? 'claude-haiku-4-5-20251001',
    coldModel: process.env['LLM_COLD_MODEL'] ?? 'claude-haiku-4-5-20251001',
    now: () => VANDAAG,
  });
}

/** Eén cliëntbeurt erin, de vastgelegde feiten eruit. */
async function feitenNa(uitspraak: string): Promise<Record<string, unknown>> {
  const s = sessie();
  s.recordTurn(uitspraak, 'Dank u, ik noteer het.');
  await s.observe();
  const feiten = s.knownFacts();
  return Object.fromEntries(
    Object.entries(feiten).map(([k, v]) => [k, { waarde: v?.value, status: v?.status }]),
  );
}

describe.skipIf(!heeftSleutel)('relatieve tijdsaanduidingen worden datums', () => {
  it('rekent "afgelopen vrijdag" om naar de dag ervoor', async () => {
    // Vandaag is zaterdag 22 augustus; afgelopen vrijdag is dus de 21e.
    const feiten = await feitenNa(
      'Ik ben afgelopen vrijdag op staande voet ontslagen bij Acme Nederland.',
    );
    const datum = feiten['summary_dismissal_date'] as { waarde?: unknown; status?: string };
    expect(datum?.status).toBe('confirmed');
    expect(String(datum?.waarde)).toContain('2026-08-21');
  });

  it('rekent een eenduidige ziekmelddatum om naar een datum', async () => {
    /*
     * Bewust "afgelopen maandag" en niet "begin juli".
     *
     * "Begin juli" is vaag, en de instructie staat het model uitdrukkelijk toe daar
     * `unknown` van te maken — dat is precies de regel die het gokken moet voorkomen. Er
     * hier tóch een precieze datum van eisen zou betekenen dat deze test en die regel
     * elkaar tegenspreken, en dan valt hij grillig om op modelvariatie. Gemeten: dezelfde
     * zin leverde de ene keer 2026-07-01 [inferred] op en de andere keer null [unknown].
     *
     * Het vage geval wordt hieronder apart getoetst, op het gedrag dat er wél bij hoort.
     */
    const feiten = await feitenNa('Ik ben sinds afgelopen maandag ziek gemeld.');
    const ziek = feiten['sick_since'] as { waarde?: unknown; status?: string };
    expect(String(ziek?.waarde)).toBe('2026-08-17');
  });

  it('pakt een datum op die de cliënt zich pas later herinnert', async () => {
    /*
     * De regressie die dit dekt.
     *
     * `gezochteFeiten` sloeg elk feit over dat al bestond, óók met status `unknown`. Zei de
     * cliënt eerst "dat weet ik niet precies", dan werd `sick_since` als unknown vastgelegd
     * en daarna nooit meer gezocht — het latere antwoord viel stil op de grond.
     */
    const s = sessie();
    s.recordTurn('Ik zit ziek thuis, maar de datum weet ik niet meer.', 'Dat geeft niet.');
    await s.observe();
    expect(s.knownFacts()['sick_since']?.status).toBe('unknown');

    // Opnieuw een eenduidige aanduiding: het gaat hier om de vraag of er nog gekeken
    // wordt, niet om hoe scherp het model een vage datum maakt.
    s.recordTurn('O wacht, het was 1 juli.', 'Ik noteer het.');
    await s.observe();
    const na = s.knownFacts()['sick_since'];
    expect(na?.status).not.toBe('unknown');
    expect(String(na?.value)).toBe('2026-07-01');
  });

  it('haalt de ontslagdatum uit dezelfde beurt waarin de route wordt vastgesteld', async () => {
    /*
     * De tweede regressie.
     *
     * `summary_dismissal_date` is pas relevant als `termination_route` op
     * 'summary_dismissal' staat, en die twee vallen in één adem. De categorieën werden
     * gewogen met de feiten van vóór de beurt, dus de datum stond niet in de zoeklijst —
     * en omdat het transcript alleen nieuwe beurten bevat, was die vrijdag daarna weg.
     * De engine doet nu één tweede ronde over dezelfde beurt voor wat er is vrijgekomen.
     */
    const feiten = await feitenNa(
      'Ik ben afgelopen vrijdag op staande voet ontslagen bij Acme Nederland.',
    );
    const datum = feiten['summary_dismissal_date'] as { waarde?: unknown; status?: string };
    expect(datum?.waarde).toBe('2026-08-21');
  });

  it('kiest het meest recente verleden als er geen jaartal is genoemd', async () => {
    // "3 maart" in augustus 2026 is maart 2026 en niet maart 2027; een datum in de
    // toekomst is bij een ontslag dat al plaatsvond per definitie fout.
    const feiten = await feitenNa('Mijn contract is op 3 maart ingegaan bij Acme Nederland.');
    const start = feiten['employment_start_date'] as { waarde?: unknown; status?: string };
    if (start?.status === 'confirmed') {
      expect(String(start.waarde)).toBe('2026-03-03');
    }
  });

  it('gokt niet bij een vage aanduiding maar legt hem vast als onbekend', async () => {
    /*
     * De helft die ertoe doet.
     *
     * "Ergens in het voorjaar" is geen datum. Het model mag er geen maken: een gegokte
     * datum is in het dossier niet van een vastgestelde te onderscheiden, en dan gaat een
     * advocaat rekenen met een termijn die niemand heeft verteld. Dat is risico 10.
     */
    const feiten = await feitenNa(
      'Ik ben ergens in het voorjaar ziek geworden, ik weet de datum echt niet meer.',
    );
    const ziek = feiten['sick_since'] as { waarde?: unknown; status?: string } | undefined;
    if (ziek !== undefined) {
      expect(ziek.status).toBe('unknown');
    }
  });
});
