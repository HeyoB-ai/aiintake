import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentClient,
  anonUser,
  asUser,
  createFixture,
  destroyFixture,
  expireSessionToken,
  explainMissingTestEnv,
  issueSession,
  readTestEnv,
  serviceClient,
  type AgentSessionFixture,
  type Fixture,
  type TestEnv,
} from './harness';

/**
 * Fase 0 is klaar wanneer deze tests groen zijn (§13).
 *
 * Ze draaien tegen een echte database. Ontbreken de credentials, dan slaan ze over —
 * met een melding, niet stilzwijgend, want een overgeslagen isolatietest die eruitziet
 * als een geslaagde is precies het soort geruststelling waar dit project niet tegen kan.
 */

const env = readTestEnv();
const describeDb = env ? describe : describe.skip;

if (!env) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n[tenant-isolatie] OVERGESLAGEN — de SUPABASE_TEST_* configuratie is niet compleet.\n' +
      `${explainMissingTestEnv()}\n\n` +
      'Deze suite is de Definition of Done van Fase 0 en bewijst zonder database niets.\n' +
      'Zie README §"Tests tegen een echte database".\n',
  );
}

describeDb('tenant-isolatie', () => {
  const testEnv = env as TestEnv;
  let fx: Fixture;

  beforeAll(async () => {
    fx = await createFixture(testEnv);
  }, 60_000);

  afterAll(async () => {
    if (fx) await destroyFixture(testEnv, fx);
  }, 60_000);

  describe('gebruiker van kantoor A ziet niets van kantoor B', () => {
    it('intakes', async () => {
      const a = asUser(testEnv, fx.tokenA);
      const { data, error } = await a.from('intakes').select('id, organization_id');
      expect(error).toBeNull();
      const ids = (data ?? []).map((r) => r.id);
      expect(ids).toContain(fx.intakeA);
      expect(ids).not.toContain(fx.intakeB);
    });

    it('organizations', async () => {
      const a = asUser(testEnv, fx.tokenA);
      const { data } = await a.from('organizations').select('id');
      const ids = (data ?? []).map((r) => r.id);
      expect(ids).toEqual([fx.orgA]);
    });

    it('organization_users', async () => {
      const a = asUser(testEnv, fx.tokenA);
      const { data } = await a.from('organization_users').select('organization_id');
      const orgs = new Set((data ?? []).map((r) => r.organization_id));
      expect(orgs.has(fx.orgA)).toBe(true);
      expect(orgs.has(fx.orgB)).toBe(false);
    });

    it('gericht opvragen van een intake van B levert niets op', async () => {
      const a = asUser(testEnv, fx.tokenA);
      const { data, error } = await a.from('intakes').select('id').eq('id', fx.intakeB);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it('een intake van B bijwerken raakt nul rijen', async () => {
      const a = asUser(testEnv, fx.tokenA);
      const { data } = await a
        .from('intakes')
        .update({ subject: 'gekaapt' })
        .eq('id', fx.intakeB)
        .select('id');
      expect(data ?? []).toEqual([]);

      // En de waarde staat er ook echt nog zoals hij was.
      const svc = serviceClient(testEnv);
      const { data: after } = await svc
        .from('intakes')
        .select('subject')
        .eq('id', fx.intakeB)
        .single();
      expect(after?.subject).toBe('Loon');
    });

    it.each([
      ['messages'],
      ['case_facts'],
      ['risk_flags'],
      ['lawyer_requests'],
      ['summaries'],
      ['sessions'],
      ['session_tokens'],
      ['llm_calls'],
      ['consent_records'],
      ['documents'],
      ['document_analysis'],
      ['audit_log'],
    ])('kindtabel %s lekt geen rijen van B', async (table) => {
      const svc = serviceClient(testEnv);
      // Zet er iets in namens B, zodat "leeg" niet per ongeluk klopt.
      if (table === 'messages') {
        await svc.from('messages').insert({
          organization_id: fx.orgB,
          intake_id: fx.intakeB,
          turn_index: 0,
          role: 'client',
          content: 'geheim van B',
        });
      }

      const a = asUser(testEnv, fx.tokenA);
      const { data, error } = await a.from(table).select('organization_id');
      expect(error).toBeNull();
      const leaked = (data ?? []).filter((r: any) => r.organization_id === fx.orgB);
      expect(leaked).toEqual([]);
    });
  });

  describe('anon', () => {
    it('kan geen intakes lezen', async () => {
      const { data } = await anonUser(testEnv).from('intakes').select('id');
      expect(data ?? []).toEqual([]);
    });

    it('kan geen organisatieconfiguratie lezen', async () => {
      const { data } = await anonUser(testEnv).from('organizations').select('provider_config');
      expect(data ?? []).toEqual([]);
    });

    it('krijgt via public_org_by_slug alleen publieke velden', async () => {
      const { data, error } = await anonUser(testEnv, 'app').rpc('public_org_by_slug', {
        p_slug: `test-a-${fx.suffix}`,
      });
      expect(error).toBeNull();
      const row = (data as any[])[0];
      expect(row.name).toBe('Kantoor A');
      // De gevoelige kolommen komen niet mee in het resultaat.
      expect(row).not.toHaveProperty('provider_config');
      expect(row).not.toHaveProperty('intake_criteria');
      expect(row).not.toHaveProperty('retention_policy');
    });
  });

  describe('het sessietoken van de agent', () => {
    let sessionA: AgentSessionFixture;

    beforeAll(async () => {
      sessionA = await issueSession(testEnv, { intakeId: fx.intakeA });
    });

    const append = (token: string, intakeId: string, turnIndex: number, content: string) =>
      agentClient(testEnv).rpc('agent_append_message', {
        p_session_token: token,
        p_intake_id: intakeId,
        p_turn_index: turnIndex,
        p_role: 'assistant',
        p_content: content,
      });

    it('mag naar zijn eigen intake schrijven', async () => {
      const { data, error } = await append(
        sessionA.sessionToken,
        fx.intakeA,
        0,
        'Goedemiddag, ik ben de intake-assistent.',
      );
      expect(error).toBeNull();
      expect(data).toBeTruthy();
    });

    it('leidt de sessie uit het token af — er is geen sessie-parameter om te vervalsen', async () => {
      const { data, error } = await agentClient(testEnv).rpc('agent_context', {
        p_session_token: sessionA.sessionToken,
        p_intake_id: fx.intakeA,
      });
      expect(error).toBeNull();
      expect((data as any).intake.id).toBe(fx.intakeA);
      expect((data as any).sessionId).toBe(sessionA.sessionId);
    });

    it('mag NIET naar een andere intake schrijven', async () => {
      const { error } = await append(sessionA.sessionToken, fx.intakeB, 0, 'dit hoort hier niet');
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/niet gebonden aan deze intake/i);
    });

    it('een token van kantoor B werkt niet op de intake van kantoor A', async () => {
      const sessionB = await issueSession(testEnv, { intakeId: fx.intakeB });
      const { error } = await append(sessionB.sessionToken, fx.intakeA, 1, 'cross-tenant');
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/niet gebonden aan deze intake/i);
    });

    it('een verlopen token wordt geweigerd', async () => {
      const expiring = await issueSession(testEnv, { intakeId: fx.intakeA });
      // Werkt eerst wél — anders bewijst de afwijzing hieronder niets.
      const before = await append(expiring.sessionToken, fx.intakeA, 10, 'nog geldig');
      expect(before.error).toBeNull();

      await expireSessionToken(testEnv, expiring.sessionId);

      const after = await append(expiring.sessionToken, fx.intakeA, 11, 'te laat');
      expect(after.error).not.toBeNull();
      expect(after.error!.message).toMatch(/geen geldig agent-token/i);
    });

    it('een ingetrokken token wordt geweigerd', async () => {
      const revoking = await issueSession(testEnv, { intakeId: fx.intakeA });
      const svc = serviceClient(testEnv, 'app');
      const { error: revokeErr } = await svc.rpc('revoke_agent_session', {
        p_session_id: revoking.sessionId,
      });
      expect(revokeErr).toBeNull();

      const { error } = await append(revoking.sessionToken, fx.intakeA, 20, 'ingetrokken');
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/geen geldig agent-token/i);
    });

    it('einde sessie trekt het token direct in', async () => {
      // De meeste sessies eindigen ruim vóór hun TTL. Precies dat gat is waar een
      // gelekt token anders nog bruikbaar zou zijn.
      const ending = await issueSession(testEnv, { intakeId: fx.intakeA });
      const agent = agentClient(testEnv);

      const { error: endErr } = await agent.rpc('agent_end_session', {
        p_session_token: ending.sessionToken,
        p_intake_id: fx.intakeA,
        p_end_reason: 'completed',
        p_billed_seconds: 120,
      });
      expect(endErr).toBeNull();

      const { error } = await append(ending.sessionToken, fx.intakeA, 30, 'na afloop');
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/geen geldig agent-token/i);
    });

    it.each([
      ['onbekend maar goed gevormd', 'A'.repeat(43)],
      ['leeg', ''],
      ['te kort', 'kort'],
      ['absurd lang', 'x'.repeat(5000)],
      ['ziet eruit als een hash', 'a'.repeat(64)],
    ])('een %s token wordt geweigerd', async (_name, token) => {
      const { error } = await append(token, fx.intakeA, 40, 'gegokt');
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/geen geldig agent-token/i);
    });

    it('het token werkt niet als bearer credential in de Authorization-header', async () => {
      // Het is geen JWT en hoort daar niet; deze test legt vast dat een toekomstige
      // "handige" refactor die het alsnog in de header legt, niet stilzwijgend werkt.
      const client = asUser(testEnv, sessionA.sessionToken, 'app');
      const { error } = await client.rpc('agent_context', {
        p_session_token: sessionA.sessionToken,
        p_intake_id: fx.intakeA,
      });
      expect(error).not.toBeNull();
    });

    it('zonder token kan een ingelogde medewerker de agent-RPC niet misbruiken', async () => {
      const a = asUser(testEnv, fx.tokenA, 'app');
      const { error } = await a.rpc('agent_append_message', {
        p_session_token: 'geen-echt-token-maar-lang-genoeg-voor-de-lengtecheck',
        p_intake_id: fx.intakeA,
        p_turn_index: 99,
        p_role: 'assistant',
        p_content: 'via een mensentoken',
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/geen geldig agent-token/i);
    });

    it('de agent kan geen enkele tabel rechtstreeks lezen', async () => {
      // De worker draait op de publishable key: RLS geeft hem niets. Alles loopt via
      // de RPC's, en die zijn per intake afgebakend.
      const agent = agentClient(testEnv);
      const publicSchema = anonUser(testEnv, 'public');
      for (const table of ['intakes', 'messages', 'case_facts', 'organizations']) {
        const { data } = await publicSchema.from(table).select('*');
        expect(data ?? []).toEqual([]);
      }
      expect(agent).toBeTruthy();
    });
  });

  describe('uitgifte van sessietokens', () => {
    it('kan niet door een cliënt of anonieme bezoeker', async () => {
      const { error } = await anonUser(testEnv, 'app').rpc('issue_agent_session', {
        p_intake_id: fx.intakeA,
        p_channel: 'video',
        p_token_hash: 'a'.repeat(64),
        p_ttl_minutes: 30,
      });
      expect(error).not.toBeNull();
    });

    it('kan niet door een ingelogde ORG_ADMIN', async () => {
      // Ook de beheerder van het eigen kantoor niet: uitgifte hoort bij de serverkant
      // van de web-app, niet bij een browsersessie.
      const { error } = await asUser(testEnv, fx.tokenA, 'app').rpc('issue_agent_session', {
        p_intake_id: fx.intakeA,
        p_channel: 'video',
        p_token_hash: 'a'.repeat(64),
        p_ttl_minutes: 30,
      });
      expect(error).not.toBeNull();
    });

    it('weigert een TTL van nul of minder', async () => {
      const { error } = await serviceClient(testEnv, 'app').rpc('issue_agent_session', {
        p_intake_id: fx.intakeA,
        p_channel: 'video',
        p_token_hash: 'b'.repeat(64),
        p_ttl_minutes: 0,
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/ttl_minutes/i);
    });

    it('kapt de TTL af op de maximale sessieduur van het kantoor', async () => {
      // Een token dat langer leeft dan de sessie is precies wat we niet willen.
      const session = await issueSession(testEnv, { intakeId: fx.intakeA, ttlMinutes: 10_000 });
      const maxMs = (25 + 5) * 60 * 1000;
      const ttlMs = new Date(session.expiresAt).getTime() - Date.now();
      expect(ttlMs).toBeLessThanOrEqual(maxMs + 60_000);
      expect(ttlMs).toBeGreaterThan(0);
    });

    it('de tabel met tokenhashes is voor niemand leesbaar', async () => {
      for (const client of [anonUser(testEnv), asUser(testEnv, fx.tokenA)]) {
        const { data } = await client.from('session_tokens').select('token_hash');
        expect(data ?? []).toEqual([]);
      }
    });

    it('slaat het ruwe token nergens op', async () => {
      const session = await issueSession(testEnv, { intakeId: fx.intakeA });
      const svc = serviceClient(testEnv);
      const { data } = await svc
        .from('session_tokens')
        .select('token_hash')
        .eq('session_id', session.sessionId);

      const hashes = (data ?? []).map((r: any) => r.token_hash);
      expect(hashes).toHaveLength(1);
      expect(hashes[0]).not.toBe(session.sessionToken);
      expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('rolrechten binnen de eigen organisatie', () => {
    it('INTAKE_STAFF mag een intake niet verwijderen', async () => {
      const svc = serviceClient(testEnv);
      await svc
        .from('organization_users')
        .update({ role: 'INTAKE_STAFF' })
        .eq('organization_id', fx.orgA)
        .eq('user_id', fx.userA);

      const a = asUser(testEnv, fx.tokenA);
      const { data } = await a.from('intakes').delete().eq('id', fx.intakeA).select('id');
      expect(data ?? []).toEqual([]);

      await svc
        .from('organization_users')
        .update({ role: 'ORG_ADMIN' })
        .eq('organization_id', fx.orgA)
        .eq('user_id', fx.userA);
    });

    it('een verwijderd lidmaatschap (deleted_at) geeft geen toegang meer', async () => {
      const svc = serviceClient(testEnv);
      await svc
        .from('organization_users')
        .update({ deleted_at: new Date().toISOString() })
        .eq('organization_id', fx.orgA)
        .eq('user_id', fx.userA);

      const a = asUser(testEnv, fx.tokenA);
      const { data } = await a.from('intakes').select('id');
      expect(data ?? []).toEqual([]);

      await svc
        .from('organization_users')
        .update({ deleted_at: null })
        .eq('organization_id', fx.orgA)
        .eq('user_id', fx.userA);
    });
  });

  describe('auditlog is append-only', () => {
    it('kan niet worden gewijzigd of verwijderd door een ORG_ADMIN', async () => {
      const svc = serviceClient(testEnv);
      const { data: entry } = await svc
        .from('audit_log')
        .insert({
          organization_id: fx.orgA,
          action: 'intake.viewed',
          actor_type: 'system',
          entity_type: 'intake',
          entity_id: fx.intakeA,
          intake_id: fx.intakeA,
        })
        .select('id')
        .single();

      const a = asUser(testEnv, fx.tokenA);
      const { data: updated } = await a
        .from('audit_log')
        .update({ action: 'intake.exported' })
        .eq('id', entry!.id)
        .select('id');
      expect(updated ?? []).toEqual([]);

      const { data: deleted } = await a.from('audit_log').delete().eq('id', entry!.id).select('id');
      expect(deleted ?? []).toEqual([]);
    });
  });
});
