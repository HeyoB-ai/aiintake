import { createAgentClient, createAgentRpc, type AgentRpc } from '@intake/db-core';
import { readAgentEnv } from './env.js';
import { log } from './log.js';

/**
 * De realtime worker.
 *
 * Fase 0 levert hier het skelet: envvalidatie, de agent-veilige client en de
 * bevestiging dat dit proces uitsluitend via het RPC-oppervlak werkt. De beurtcyclus
 * (STT → planner → hot path → TTS → avatar), de barge-in-lus en de latency-HUD komen
 * in Fase 1 — dat is de risicospike, en die vraagt om accounts bij een avatarvendor.
 *
 * Waarom dit een eigen proces is en geen Next.js route: een WebRTC-mediastroom met
 * barge-in vraagt om een langlevend proces met een open audio/videoverbinding.
 * Serverless routes hebben geen persistente sockets, kennen cold starts en
 * executielimieten, en zijn daar structureel ongeschikt voor.
 */

export interface SessionHandle {
  readonly intakeId: string;
  readonly sessionId: string;
  readonly rpc: AgentRpc;
}

/**
 * Start de verwerking van één intake.
 *
 * De worker krijgt het sessietoken aangereikt en maakt het niet zelf: wie zijn eigen
 * credential mag uitgeven, heeft er geen. Het token is ondoorzichtig, gebonden aan
 * deze ene intake, en verloopt met de sessie.
 */
export async function attachToIntake(args: {
  intakeId: string;
  sessionToken: string;
}): Promise<SessionHandle> {
  const env = readAgentEnv();
  const client = createAgentClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY);
  const rpc = createAgentRpc(client, {
    sessionToken: args.sessionToken,
    intakeId: args.intakeId,
  });

  // Eén call haalt organisatieconfiguratie, feiten, transcript en openstaande
  // advocaatverzoeken op. Dit is meteen de eerste tokenverificatie: is het verlopen,
  // ingetrokken of aan een andere intake gebonden, dan gooit dit AgentTokenRejected
  // en stopt de sessie hier.
  const context = await rpc.context();

  log.info('intake gekoppeld', {
    intakeId: args.intakeId,
    sessionId: context.sessionId,
    turnCount: context.intake.turn_count,
    factCount: context.facts.length,
    avatarProvider: env.AVATAR_PROVIDER,
  });

  return { intakeId: args.intakeId, sessionId: context.sessionId, rpc };
}

async function main(): Promise<void> {
  const env = readAgentEnv();
  log.info('worker gestart', {
    avatarProvider: env.AVATAR_PROVIDER,
    hot: env.LLM_HOT_MODEL,
    cold: env.LLM_COLD_MODEL,
  });
  log.info('wacht op sessies — de realtime-lus volgt in Fase 1');
}

// Alleen draaien als dit bestand het startpunt is, niet bij import vanuit een test.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((error: unknown) => {
    log.error('worker gestopt', { message: error instanceof Error ? error.message : 'onbekend' });
    process.exitCode = 1;
  });
}
