/**
 * De volledige databaselaag, voor apps/web.
 *
 * Re-exporteert alles uit @intake/db-core en voegt toe wat alleen een vertrouwde
 * serveromgeving mag hebben: de RLS-omzeilende client, envvalidatie en het uitgeven
 * van agent-sessietokens. apps/agent hangt aan db-core en krijgt dit dus niet.
 */
export * from '@intake/db-core';
export * from './agent-session';
export * from './env';
export * from './service-client';
export { createSessionToken, hashSessionToken, type IssuedToken } from './agent-token';
