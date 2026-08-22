# ADR-0002 — De agent-worker heeft geen service-role key

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0

## Context

Het grootste RLS-omzeilingsrisico in dit project is de agent-worker: een langlevend,
van buiten bereikbaar proces dat met een service-role key bij elke tenant zou kunnen.
Eén lek in dat proces is dan een lek van alle kantoren tegelijk.

## Besluit

De worker krijgt die sleutel niet. In plaats daarvan:

1. Bij sessiestart mint `apps/web` een JWT met claim `intake_id`, TTL = sessieduur + 5
   minuten (`packages/db/src/agent-token.ts`).
2. Het token draagt `role: authenticated` zodat PostgREST het accepteert, maar levert
   géén organisatielidmaatschap op. Elke RLS-policy wijst het dus af — de worker kan
   letterlijk geen enkele tabel rechtstreeks lezen.
3. Alles wat de worker doet, loopt via de `app.agent_*` RPC's uit migratie 0600. Elke
   functie begint met `app.assert_agent_scope(p_intake_id)`, die controleert dat de
   claim overeenkomt met de intake die wordt aangeraakt.

Om dit af te dwingen in plaats van af te spreken, is de databaselaag gesplitst:

- `@intake/db-core` — anon-client, agent-client, RPC-wrappers. Hier hangt `apps/agent`
  aan.
- `@intake/db` — daarbovenop de service-role client, de envlezer en het minten van
  tokens. Hier hangt `apps/web` aan.

Twee controles bewaken dit: een dependency-cruiser-regel (`agent-never-imports-full-db`)
en een broncodescan (`packages/db/src/__tests__/agent-has-no-service-role.test.ts`) die
faalt zodra `apps/agent` de sleutelnamen, de RLS-omzeilende client of de mintfunctie
noemt.

## Gevolgen

- Een gecompromitteerde worker kan hoogstens één intake beschadigen, niet elke tenant.
- Het RPC-oppervlak is bewust smal en moet bewust groeien; dat is het punt.
- De worker kan geen ad-hoc query's doen. `app.agent_context()` levert daarom in één
  call organisatieconfiguratie, feiten, transcript, documenten en openstaande
  advocaatverzoeken.

## Verificatiestatus

De broncodescan draait en is groen. De runtime-helft — dat een agent-token van intake A
daadwerkelijk 42501 krijgt op intake B — staat als test klaar in
`tenant-isolation.test.ts` maar heeft een echte database nodig. Zie
[RISICOS.md](RISICOS.md), risico 1.
