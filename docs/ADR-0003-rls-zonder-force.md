# ADR-0003 — RLS met ENABLE, bewust zonder FORCE

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0

## Context

De eis is dat RLS op elke tabel aan staat, zonder uitzondering. De eerste opzet zette
daarom zowel `enable row level security` als `force row level security` op elke tabel.

`FORCE` doet echter iets anders dan het lijkt: het laat RLS óók gelden voor de
tabeleigenaar. En de tabeleigenaar is precies de rol waaronder `SECURITY DEFINER`
functies draaien. Met FORCE zou elke RPC in migratie 0600 stuklopen op policies die er
voor die rol niet zijn — en daarmee de volledige publieke intakeroute én het complete
agent-oppervlak, want die twee aanroepers hebben per ontwerp geen lidmaatschap en dus
geen enkele policy die hen toelaat.

## Besluit

`enable row level security` op elke tabel; geen `force`.

De tenantgrens wordt gedragen door policies voor `authenticated` en `anon` — de enige
rollen die een client ooit heeft. `service_role` omzeilt RLS via het `bypassrls`
roll-attribuut, wat losstaat van FORCE en dus sowieso niet door FORCE zou zijn
tegengehouden.

## Gevolgen

- Alle `SECURITY DEFINER` RPC's werken zoals bedoeld.
- Wie als `postgres` op de database zit, ziet alles. Dat was met FORCE ook al zo voor
  `service_role`, en directe databasetoegang is sowieso een aparte, contractuele
  kwestie (auditrecht, toegangslogging) — geen probleem dat een policy oplost.
- De test `schema-parity.test.ts` controleert dat elke `create table` een bijbehorende
  `enable row level security` heeft, zodat een nieuwe tabel niet per ongeluk zonder
  RLS de productie in gaat.

## Alternatief dat is overwogen

FORCE behouden en de `SECURITY DEFINER` functies laten draaien onder een aparte rol die
niet de tabeleigenaar is, met expliciete policies voor die rol. Dat werkt, maar
verdubbelt het aantal policies en verplaatst de complexiteit zonder iets toe te voegen:
de rol zou precies de rechten krijgen die hij nu impliciet heeft.
