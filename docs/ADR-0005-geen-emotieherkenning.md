# ADR-0005 — Emotieherkenning: architectonisch verbod, geen uitgezette feature

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0

## Context

Emotieherkenning ligt technisch dicht bij wat we al doen — dezelfde landmarks, een
classifier erachter. Juist daarom moet het besluit expliciet zijn.

De EU AI Act verbiedt emotieherkenningssystemen op de werkplek en in het onderwijs, en
merkt emotieherkenning daarbuiten aan als hoogrisico, naast de transparantieverplichting
voor systemen die met mensen interacteren. Een intake over een arbeidsconflict ligt
oncomfortabel dicht tegen die werkplekcontext aan.

Daar komt een productargument bij: de intake bepaalt mede of een kantoor een zaak
aanneemt. Een systeem dat gedrag afleidt uit gezichtsuitdrukking en dat meeweegt in die
beslissing, is niet uit te leggen aan de cliënt en niet te verdedigen tegenover een
toezichthouder.

## Besluit

De interface mag bestaan; de implementatie niet.

`EmotionExtension` staat in `packages/domain/src/schemas/visual-signals.ts` met een
`never`-veld, zodat hij niet te implementeren is zonder de typedefinitie te wijzigen.
`EMOTION_RECOGNITION_ENABLED` is een `as const` false — bewust geen env-variabele, want
een vlag die in principe aan kan, staat in de praktijk ooit aan.

Er komt geen classifier in de codebase. Ook niet uitgeschakeld, ook niet achter een
feature flag, ook niet "voor onderzoek".

## Waarom niet gewoon uitzetten

Een uitgeschakelde-maar-werkende classifier is niet verdedigbaar tegenover een auditor:
de vraag is dan niet óf het systeem het kan, maar wie de knop mag omzetten. Een
niet-bestaande implementatie is wel verdedigbaar.

## Openstaand

Laat een jurist toetsen of de werkplekcontext hier daadwerkelijk van toepassing is.
Bouw ondertussen alsof het verboden is — dat kost niets en voorkomt dat de conclusie
achteraf een herbouw betekent.
