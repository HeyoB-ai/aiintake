import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asUser,
  createFixture,
  destroyFixture,
  explainMissingTestEnv,
  readTestEnv,
  serviceClient,
  type Fixture,
  type TestEnv,
} from './harness';

/**
 * Wat de intakedetailpagina opvraagt, langs de grens van een ánder kantoor.
 *
 * De pagina zelf filtert nergens op `organization_id` — dat is met opzet: RLS is de grens,
 * en een filter in de applicatielaag zou de indruk wekken dat de grens dáár ligt. Dat
 * ontwerp is alleen verdedigbaar als het ook echt zo werkt, en dat is wat hier gemeten
 * wordt: dezelfde zeven queries als de pagina doet, uitgevoerd als een gebruiker van
 * kantoor B tegen een dossier van kantoor A.
 *
 * Plus `log_intake_viewed`. Die schrijft in een tabel zonder insert-policy en draait als
 * `security definer` — precies het soort functie waarin een ontbrekende controle
 * onzichtbaar blijft tot iemand hem misbruikt.
 */

const env: TestEnv | null = readTestEnv();
const uit = env === null;

describe.skipIf(uit)('detailpagina — RLS', () => {
  if (uit) {
    console.warn(explainMissingTestEnv());
  }

  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture(env!);
  });

  afterAll(async () => {
    if (fixture) await destroyFixture(env!, fixture);
  });

  it('geeft kantoor B niets van het dossier van kantoor A', async () => {
    const b = asUser(env!, fixture.tokenB);

    // Dezelfde tabellen als laadIntake() aanspreekt. Eén ervan vergeten in de policies is
    // genoeg om een heel dossier te lekken, dus ze staan hier allemaal.
    for (const tabel of ['case_facts', 'risk_flags', 'documents', 'messages', 'summaries']) {
      const { data, error } = await b.from(tabel).select('*').eq('intake_id', fixture.intakeA);
      expect(error, `${tabel} gaf een fout`).toBeNull();
      expect(data, `${tabel} lekte rijen van een ander kantoor`).toEqual([]);
    }

    const { data: intake } = await b
      .from('intakes')
      .select('id')
      .eq('id', fixture.intakeA)
      .maybeSingle();
    // De pagina roept notFound() aan bij `null`; een 404 verraadt niet dát het dossier
    // bestaat, en dat is bij een advocatenkantoor geen detail.
    expect(intake).toBeNull();

    const { data: audit } = await b.from('audit_log').select('id').eq('intake_id', fixture.intakeA);
    expect(audit).toEqual([]);
  });

  it('laat kantoor A zijn eigen dossier wél zien', async () => {
    // Zonder deze helft bewijst de test hierboven niets: een policy die alles weigert
    // slaagt er ook voor.
    const a = asUser(env!, fixture.tokenA);
    const { data } = await a.from('intakes').select('id').eq('id', fixture.intakeA).maybeSingle();
    expect(data?.id).toBe(fixture.intakeA);
  });

  it('log_intake_viewed schrijft niets voor een dossier van een ander kantoor', async () => {
    const b = asUser(env!, fixture.tokenB);
    const { error } = await b.rpc('log_intake_viewed', { p_intake_id: fixture.intakeA });
    // Geen fout: de functie doet stil niets. Een fout zou de pagina laten crashen op iets
    // wat geen toegangscontrole is — die zit in RLS.
    expect(error).toBeNull();

    const svc = serviceClient(env!);
    const { data } = await svc
      .from('audit_log')
      .select('id, actor_user_id')
      .eq('intake_id', fixture.intakeA)
      .eq('action', 'intake.viewed');
    expect(data ?? []).toEqual([]);
  });

  it('log_intake_viewed legt een echte inzage wél vast, met de juiste actor', async () => {
    const a = asUser(env!, fixture.tokenA);
    const { error } = await a.rpc('log_intake_viewed', { p_intake_id: fixture.intakeA });
    expect(error).toBeNull();

    const svc = serviceClient(env!);
    const { data } = await svc
      .from('audit_log')
      .select('actor_user_id, actor_type, organization_id')
      .eq('intake_id', fixture.intakeA)
      .eq('action', 'intake.viewed');

    expect(data).toHaveLength(1);
    // De actor komt uit de sessie en niet uit de aanroep: de functie neemt geen actor als
    // parameter, juist zodat niemand een inzage op andermans naam kan zetten.
    expect(data?.[0]?.actor_user_id).toBe(fixture.userA);
    expect(data?.[0]?.organization_id).toBe(fixture.orgA);
  });
});

describe('intake.viewed wordt één keer vastgelegd', () => {
  /**
   * Gemeld vanaf een iPhone: vier regels `intake.viewed` binnen twee seconden bij één
   * bezoek. Op Chromium is het er precies één per navigatie — gemeten met drie
   * navigatievormen — dus de browser bepaalt hoe vaak de pagina rendert en de applicatie
   * kan dat niet afdwingen.
   *
   * Een auditlog waarin één inzage vier regels oplevert is als bewijs onbruikbaar, en de
   * echte gebeurtenissen verdrinken erin. Vandaar dat de ontdubbeling in de RPC zit en
   * niet in de pagina.
   */
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await createFixture(env!);
  });

  afterAll(async () => {
    if (fixture) await destroyFixture(env!, fixture);
  });

  async function inzages(): Promise<number> {
    const svc = serviceClient(env!);
    const { count } = await svc
      .from('audit_log')
      .select('id', { count: 'exact', head: true })
      .eq('intake_id', fixture.intakeA)
      .eq('action', 'intake.viewed');
    return count ?? 0;
  }

  it('telt tien aanroepen achter elkaar als één inzage', async () => {
    const a = asUser(env!, fixture.tokenA);
    for (let i = 0; i < 10; i += 1) {
      await a.rpc('log_intake_viewed', { p_intake_id: fixture.intakeA });
    }
    expect(await inzages()).toBe(1);
  });

  it('telt twaalf gelijktijdige aanroepen ook als één inzage', async () => {
    /*
     * Dit is het geval dat de eerste versie van de ontdubbeling niet dekte.
     *
     * Die controleerde alleen of er al een regel stond, en bij gelijktijdige aanroepen
     * lezen ze allemaal voordat de eerste heeft geschreven: acht tegelijk leverden er drie
     * op. Precies het gemelde patroon. De advisory lock maakt het paar (dossier,
     * medewerker) serieel, en pas daarmee klopt het.
     */
    const svc = serviceClient(env!);
    await svc
      .from('audit_log')
      .delete()
      .eq('intake_id', fixture.intakeA)
      .eq('action', 'intake.viewed');
    expect(await inzages()).toBe(0);

    const a = asUser(env!, fixture.tokenA);
    await Promise.all(
      Array.from({ length: 12 }, () =>
        a.rpc('log_intake_viewed', { p_intake_id: fixture.intakeA }),
      ),
    );
    expect(await inzages()).toBe(1);
  });

  it('laat een andere medewerker wél een eigen inzage vastleggen', async () => {
    // Zonder deze helft bewijst het bovenstaande niets: een functie die nooit schrijft
    // slaagt er ook voor. De ontdubbeling is per medewerker, niet per dossier.
    const svc = serviceClient(env!);
    await svc
      .from('organization_users')
      .insert({ organization_id: fixture.orgA, user_id: fixture.userB, role: 'LAWYER' });

    const b = asUser(env!, fixture.tokenB);
    await b.rpc('log_intake_viewed', { p_intake_id: fixture.intakeA });
    expect(await inzages()).toBe(2);
  });
});
