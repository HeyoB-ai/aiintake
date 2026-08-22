import { createAgentClient, agentContext } from '@intake/db-core';
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
}

/**
 * Start de verwerking van één intake. De worker krijgt het token aangereikt — hij
 * mint het niet zelf, want dan zou hij het ondertekeningsgeheim moeten kennen en
 * daarmee tokens voor willekeurige intakes kunnen maken.
 */
export async function attachToIntake(args: {
  intakeId: string;
  sessionToken: string;
}): Promise<SessionHandle> {
  const env = readAgentEnv();
  const client = createAgentClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, args.sessionToken);

  // Eén call haalt organisatieconfiguratie, feiten, transcript en openstaande
  // advocaatverzoeken op. Mislukt dit, dan is het token verlopen of niet aan deze
  // intake gebonden — in beide gevallen stopt de sessie hier.
  const context = await agentContext(client, args.intakeId);

  log.info('intake gekoppeld', {
    intakeId: args.intakeId,
    turnCount: context.intake.turn_count,
    factCount: context.facts.length,
    avatarProvider: env.AVATAR_PROVIDER,
  });

  return { intakeId: args.intakeId, sessionId: '' };
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
