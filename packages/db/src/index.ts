/**
 * De volledige databaselaag, voor apps/web.
 *
 * Re-exporteert alles uit @intake/db-core en voegt toe wat alleen een vertrouwde
 * serveromgeving mag hebben: de service-role client, envvalidatie en het minten van
 * agent-tokens. apps/agent hangt aan db-core en krijgt dit dus niet.
 */
export * from '@intake/db-core';
export * from './env';
export * from './service-client';
export { mintAgentToken, verifyAgentToken, type AgentTokenClaims } from './agent-token';
