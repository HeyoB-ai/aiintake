# ADR-0006 — De feitcatalogus staat in code, `case_facts` blijft generiek

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0

## Context

Een intake verzamelt tientallen feiten, en die verzameling verandert vaak: een nieuwe
vraag, een aangescherpte voorwaarde, een extra rechtsgebied. De voor de hand liggende
opzet — een kolom per feit — betekent een migratie per intakevraag.

## Besluit

`public.case_facts` is een sleutel-waardetabel met `unique (intake_id, key)`, een
`value_type`, een `status`, `confidence` en herkomst. De catalogus van sleutels — namen,
types, validators, prioriteiten, labels en formuleringshints in NL en EN — staat in
`packages/domain/src/facts/employment.ts`.

Een nieuwe intakevraag kost daardoor een deploy, geen migratie. De QuestionPlanner kan
er bovendien synchroon overheen scoren zonder query, wat op het hot path (< 5 ms budget)
het verschil maakt.

## Twee dingen die dit mogelijk maakt

**`status = 'unknown'` is een opslaanbare waarde.** "Niet vastgesteld" is een feit, geen
leegte. Dat onderscheid draagt de samenvattingslogica: een ontbrekend veld en een veld
waarvan is vastgesteld dat de cliënt het niet weet, zijn voor een advocaat totaal
verschillende dingen. `evaluate()` in de engine behandelt `unknown` dan ook expliciet:
een onbekend feit bevestigt geen enkele voorwaarde.

**Herkomst is een constraint, geen conventie.** `case_facts_traceable` weigert een
feit met status confirmed/inferred/contradicted zonder `source_ref`. Dat is de
databasekant van de regel dat elke bewering in de samenvatting herleidbaar is.

## Prijs

- Geen kolomtypen, dus geen typecontrole door Postgres op de waarde zelf. De validator
  in de catalogus doet dat werk, en `schema-parity.test.ts` bewaakt dat de enums in
  code en de CHECK-constraints in SQL niet uit elkaar lopen.
- Query's over feiten zijn onhandiger dan over kolommen. Voor het dashboard is dat
  ondervangen met gedenormaliseerde kolommen op `intakes` (`client_name`, `subject`,
  `urgency_level`, `completeness`) waarop gesorteerd en gefilterd wordt.

## Consistentie bij tegenspraak

`app.agent_upsert_fact()` overschrijft een bestaand `confirmed` feit niet met een
zwakkere observatie. Spreekt een nieuwe bevestigde waarde de oude tegen, dan wordt de
status `contradicted` in plaats van dat er stilzwijgend één wint — de advocaat moet
kunnen zien dat de cliënt zichzelf tegensprak.
