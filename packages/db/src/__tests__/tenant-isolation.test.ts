import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentToken,
  anonUser,
  asUser,
  createFixture,
  destroyFixture,
  readTestEnv,
  serviceClient,
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
    '\n[tenant-isolatie] OVERGESLAGEN — geen SUPABASE_TEST_* env gevonden.\n' +
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

  describe('het sessie-JWT van de agent', () => {
    let sessionId: string;

    beforeAll(async () => {
      const svc = serviceClient(testEnv);
      const { data, error } = await svc
        .from('sessions')
        .insert({ organization_id: fx.orgA, intake_id: fx.intakeA, channel: 'video' })
        .select('id')
        .single();
      if (error) throw new Error(error.message);
      sessionId = data!.id as string;
    });

    it('mag naar zijn eigen intake schrijven', async () => {
      const token = await agentToken(testEnv, {
        intakeId: fx.intakeA,
        organizationId: fx.orgA,
        sessionId,
      });
      const agent = asUser(testEnv, token, 'app');
      const { data, error } = await agent.rpc('agent_append_message', {
        p_intake_id: fx.intakeA,
        p_session_id: sessionId,
        p_turn_index: 0,
        p_role: 'assistant',
        p_content: 'Goedemiddag, ik ben de intake-assistent.',
      });
      expect(error).toBeNull();
      expect(data).toBeTruthy();
    });

    it('mag NIET naar een andere intake schrijven', async () => {
      const token = await agentToken(testEnv, {
        intakeId: fx.intakeA,
        organizationId: fx.orgA,
        sessionId,
      });
      const agent = asUser(testEnv, token, 'app');
      const { error } = await agent.rpc('agent_append_message', {
        p_intake_id: fx.intakeB, // andere tenant
        p_session_id: sessionId,
        p_turn_index: 0,
        p_role: 'assistant',
        p_content: 'dit hoort hier niet',
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/niet gebonden aan deze intake/i);
    });

    it('kan geen enkele tabel rechtstreeks lezen', async () => {
      const token = await agentToken(testEnv, {
        intakeId: fx.intakeA,
        organizationId: fx.orgA,
        sessionId,
      });
      const agent = asUser(testEnv, token, 'public');
      for (const table of ['intakes', 'messages', 'case_facts', 'organizations']) {
        const { data } = await agent.from(table).select('*');
        expect(data ?? []).toEqual([]);
      }
    });

    it('krijgt via agent_context alleen zijn eigen intake', async () => {
      const token = await agentToken(testEnv, {
        intakeId: fx.intakeA,
        organizationId: fx.orgA,
        sessionId,
      });
      const agent = asUser(testEnv, token, 'app');
      const { data, error } = await agent.rpc('agent_context', { p_intake_id: fx.intakeA });
      expect(error).toBeNull();
      expect((data as any).intake.id).toBe(fx.intakeA);
    });

    it('een gewoon gebruikerstoken kan de agent-RPC niet misbruiken', async () => {
      const a = asUser(testEnv, fx.tokenA, 'app');
      const { error } = await a.rpc('agent_append_message', {
        p_intake_id: fx.intakeA,
        p_session_id: sessionId,
        p_turn_index: 99,
        p_role: 'assistant',
        p_content: 'via een mensentoken',
      });
      expect(error).not.toBeNull();
      expect(error!.message).toMatch(/geen geldig agent-token/i);
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
