import type { SupabaseClient } from '@supabase/supabase-js';
import { createSessionToken } from './agent-token';

/**
 * Uitgifte en intrekking van agent-sessies. Hoort bij apps/web, dat op de secret key
 * draait — de worker mag zijn eigen credential niet kunnen aanmaken of verlengen.
 *
 * De database ziet het ruwe token nooit: hier wordt het gegenereerd, alleen de hash
 * gaat de RPC in, en het ruwe token gaat rechtstreeks door naar de worker.
 */

export interface IssueSessionInput {
  intakeId: string;
  channel: 'video' | 'voice' | 'chat';
  roomName?: string | null;
  /**
   * Prewarm start zodra de cliënt het toestemmingsscherm opent, dus vóór "START
   * INTAKE". Die seconden tellen wel mee bij de avatarvendor en horen zichtbaar te
   * zijn in de kostenanalyse.
   */
  prewarmedAt?: string | null;
  /** Wordt in de RPC afgetopt op de maximale sessieduur van het kantoor plus marge. */
  ttlMinutes?: number;
}

export interface IssuedSession {
  sessionId: string;
  organizationId: string;
  expiresAt: string;
  /** Geef dit door aan de worker en nergens anders heen. Niet loggen, niet opslaan. */
  sessionToken: string;
}

export async function issueAgentSession(
  serviceClient: SupabaseClient,
  input: IssueSessionInput,
): Promise<IssuedSession> {
  const { token, tokenHash } = await createSessionToken();

  const { data, error } = await serviceClient.schema('app').rpc('issue_agent_session', {
    p_intake_id: input.intakeId,
    p_channel: input.channel,
    p_token_hash: tokenHash,
    p_ttl_minutes: input.ttlMinutes ?? null,
    p_room_name: input.roomName ?? null,
    p_prewarmed_at: input.prewarmedAt ?? null,
  });

  if (error) throw new Error(`kon sessie niet uitgeven: ${error.message}`);

  const row = (data as { session_id: string; organization_id: string; expires_at: string }[])[0];
  if (!row) throw new Error('issue_agent_session gaf geen rij terug');

  return {
    sessionId: row.session_id,
    organizationId: row.organization_id,
    expiresAt: row.expires_at,
    sessionToken: token,
  };
}

/**
 * Trekt alle tokens van een sessie in zonder de sessie te beëindigen. Voor het geval
 * een token is gelekt of een worker vastloopt — precies wat met een JWT niet kan.
 */
export async function revokeAgentSession(
  serviceClient: SupabaseClient,
  sessionId: string,
): Promise<number> {
  const { data, error } = await serviceClient.schema('app').rpc('revoke_agent_session', {
    p_session_id: sessionId,
  });
  if (error) throw new Error(`kon sessie niet intrekken: ${error.message}`);
  return (data as number) ?? 0;
}
