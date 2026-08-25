import { createServiceRoleClient as maak } from '@intake/db';

/**
 * De client met de secret key. Alleen server, alleen apps/web.
 *
 * Deze sleutel omzeilt RLS volledig. Hij hoort op precies twee plekken thuis: het uitgeven
 * van agent-sessies en het beheer. `apps/agent` mag hem niet kunnen bereiken — daar staat
 * een statische controle op in packages/db/src/__tests__/agent-has-no-service-role.test.ts.
 *
 * Het bestand heet `service` en niet `admin`, zodat een grep op "service" alles vindt wat
 * met deze sleutel werkt.
 */
export function createServiceRoleClient() {
  const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
  const secret = process.env['SUPABASE_SECRET_KEY'];
  if (!url || !secret) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL en SUPABASE_SECRET_KEY zijn nodig om een sessie uit te geven.',
    );
  }
  return maak(url, secret);
}
