# ADR-0002 — De agent-worker heeft geen service-role key

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0
**Uitvoering herzien door:** [ADR-0007](ADR-0007-agent-sessietoken.md) — het principe
hieronder blijft ongewijzigd, maar het credential is geen zelf ondertekend JWT meer.
Dat kan niet met asymmetrische signing keys, en een ondoorzichtig token is bovendien
intrekbaar.

## Context

Het grootste RLS-omzeilingsrisico in dit project is de agent-worker: een langlevend,
van buiten bereikbaar proces dat met een service-role key bij elke tenant zou kunnen.
Eén lek in dat proces is dan een lek van alle kantoren tegelijk.

## Besluit

De worker krijgt die sleutel niet. In plaats daarvan:

1. Bij sessiestart geeft `apps/web` een kortlevend credential uit dat aan één intake is
   gebonden, met een TTL van de sessieduur plus marge. De vorm daarvan staat in
   [ADR-0007](ADR-0007-agent-sessietoken.md).
2. De worker draait op de publishable key en heeft daarmee géén organisatielidmaatschap.
   Elke RLS-policy wijst hem af — hij kan letterlijk geen enkele tabel rechtstreeks
   lezen.
3. Alles wat de worker doet, loopt via de `app.agent_*` RPC's uit migratie 0600. Elke
   functie begint met `app.assert_agent_scope()`, die controleert dat het credential
   hoort bij de intake die wordt aangeraakt.

Om dit af te dwingen in plaats van af te spreken, is de databaselaag gesplitst:

- `@intake/db-core` — anon-client, agent-client, RPC-wrappers. Hier hangt `apps/agent`
  aan.
- `@intake/db` — daarbovenop de RLS-omzeilende client, de envlezer en het uitgeven van
  sessietokens. Hier hangt `apps/web` aan.

Twee controles bewaken dit: een dependency-cruiser-regel (`agent-never-imports-full-db`)
en een broncodescan (`packages/db/src/__tests__/agent-has-no-service-role.test.ts`) die
faalt zodra `apps/agent` de sleutelnamen, de RLS-omzeilende client of de
uitgiftefuncties noemt.

## Gevolgen

- Een gecompromitteerde worker kan hoogstens één intake beschadigen, niet elke tenant.
- Het RPC-oppervlak is bewust smal en moet bewust groeien; dat is het punt.
- De worker kan geen ad-hoc query's doen. `app.agent_context()` levert daarom in één
  call organisatieconfiguratie, feiten, transcript, documenten en openstaande
  advocaatverzoeken.

## Verificatiestatus

Beide helften zijn groen. De broncodescan draait bij elke `pnpm test`; de runtime-helft
is op 22 augustus 2026 bevestigd tegen een echt Supabase-project: een sessietoken van
intake A krijgt 42501 op intake B, een verlopen of ingetrokken token wordt geweigerd, en
sessie-einde trekt het token direct in.

## Wat dit besluit gelijkstelt — nagekomen op 28 augustus 2026

Dit ADR beschreef wat de worker **niet** krijgt en niet wat hij daardoor **deelt**. Dat gat
werd pas zes dagen later zichtbaar, als risico 31.

Geen eigen sleutel betekent geen eigen rol. De worker draait op de publiceerbare sleutel, en
zijn rol is daarmee `anon` — **dezelfde rol als de browser van de cliënt**. De grants aan
`anon` op de `agent_*`-functies zijn er om de worker te laten werken; dat de browser er
daarmee net zo goed bij kan, volgt er rechtstreeks uit. Gemeten: alle vier de agent-functies
voeren uit voor `anon` en struikelen pas op het sessietoken — en dat token heeft de browser
ook, want het komt mee in de WebSocket-URL.

De mitigatie hierboven ("een gecompromitteerde worker kan hoogstens één intake beschadigen")
bleek dus breder te gelden dan bedoeld: dat kon de cliënt zelf ook, bij zijn eigen intake.
Opgelost met een tweede factor; zie RISICOS.md risico 31 en migratie 20260828120000.

**De vorm om te onthouden.** Verandert een ADR een rol, een sleutel of een grens, dan hoort
erin te staan **wat daarmee gelijk wordt aan iets anders**. Niet als procesregel voor de vorm:
dit is de tweede keer dat precies deze omissie een gat opleverde dat pas maanden later
zichtbaar werd. De andere staat in ADR-0007.
