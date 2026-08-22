# Vijf technische risico's

Op volgorde van hoe hard ze het project kunnen raken. Voor privacyrisico's als aparte
categorie: zie [DPIA-input.md](DPIA-input.md).

---

## 1. De latencybegroting haalt het niet, en dat merk je pas in week 3

**Waarom dit bovenaan staat.** De hele propositie is dat het gesprek _natuurlijk_ aanvoelt.
Bij p50 boven ~1,5 s voelt elke beurt als wachten en is het product een chatbot met een
gezicht erop. De industriële mediaan voor cascaded voice agents ligt rond 1,4–1,7 s, dus
het doel van 1,2 s is ambitieus, en de vendorclaims meten niet hetzelfde ding: "<100 ms"
bij Beyond Presence is streaming inference, "180 ms" bij Anam is agent-responstijd, en
geen van beide is de tijd tussen het laatste woord van de cliënt en de eerste
mondbeweging.

**Mitigatie.** Fase 1 is expliciet de risicospike en staat vóór alle intelligentie. De
HUD meet zes stappen apart, zodat je bij overschrijding weet wélke stap het is en niet
gaat gokken. De grootste hefbomen zitten in het ontwerp: geen JSON op het hot path,
zinsgewijs flushen naar TTS, model-native end-of-turn, prewarm tijdens het
toestemmingsscherm, en colocatie van worker, STT, TTS, LLM en avatar in dezelfde
EU-regio.

**Signaal dat het misgaat.** `session_metrics` p50 boven 1,5 s na tuning, of een enkele
stap die structureel boven zijn p95-budget zit.

---

## 2. Barge-in werkt "wel", maar het transcript klopt niet

**Waarom dit gevaarlijk is.** Dit is de meest gemene realtime-bug en hij is onzichtbaar in
unit tests: als je opslaat wat het model _wilde_ zeggen in plaats van wat de cliënt
_hoorde_, denkt het model dat het de vraag over de VSO-datum al gesteld heeft terwijl de
cliënt die nooit gehoord heeft. Het gesprek bouwt dan verder op gedeelde context die
niet bestaat. Het gesprek loopt door, alles lijkt te werken, en de intake wordt stil
onbruikbaar.

**Mitigatie.** `messages.content` bevat per definitie alleen het gehoorde deel;
`intended_content` staat in een aparte kolom die nooit als conversatiegeschiedenis
gebruikt wordt. `truncateToSpoken()` rekent de prefix uit `spokenMs` (uit
`AvatarSession.interrupt()`), met woordtijdstempels als de provider die levert en anders
een lineaire schatting — liever te veel afkappen dan te weinig, want een vraag opnieuw
stellen is onschuldig en een niet-gestelde vraag als gesteld beschouwen niet. De logica
is getest; de aansluiting op de echte lus volgt in Fase 1 en krijgt daar de expliciete
truncatietest uit §11.

---

## 3. ~~De tenantgrens is geschreven maar niet bewezen~~ — GESLOTEN, 22 augustus 2026

**Uitkomst.** 44/44 isolatie-assertions groen tegen een echt Supabase-project in de EU.
De tenantgrens is geen bewering meer.

Wat daarmee is aangetoond en niet langer op vertrouwen berust:

- een gebruiker van kantoor A ziet niets van kantoor B — per tabel, gericht op id, via
  update, via de kindtabellen en via de storage-paden;
- het sessietoken van de agent krijgt 42501 op een andere intake, is geweigerd zodra het
  verlopen of ingetrokken is, en wordt bij sessie-einde direct ingetrokken;
- uitgifte van sessietokens kan niet door anon en niet door een ingelogde ORG_ADMIN;
- het auditlog is niet te wijzigen, ook niet door een beheerder.

Het concrete faalscenario uit [ADR-0007](ADR-0007-agent-sessietoken.md) — de tokenhash
wordt in TypeScript én in plpgsql berekend, en bij afwijking valideert geen enkele
sessie — **heeft zich niet voorgedaan**. De twee implementaties komen overeen.

**Wat er van dit risico overblijft.** Een regressie in RLS of in het rechtenblok merk je
alleen als de suite blijft draaien. Twee dingen houden dat overeind: `pnpm db:check`
bewaakt in CI dat er geen tabel zonder RLS bij komt en dat het API-oppervlak niet
stilletjes groeit, en de isolatiesuite zelf hoort in CI te draaien met secrets. Dat
laatste is nog niet ingeregeld — zie de openstaande opmerking onderaan.

**Openstaand.** `pnpm test:isolation` eindigt met exit code 0 wanneer alle tests worden
overgeslagen. In CI zonder secrets is die job dus groen terwijl er niets draait. Dat is
precies de stille geruststelling die dit document elders afwijst. Op te lossen met een
strict-modus (`REQUIRE_DB_TESTS=1` laat de suite falen in plaats van skippen), aan te
zetten in de CI-job.

---

## 4. Vendorafhankelijkheid, in het bijzonder de avatarleverancier

**Twee kanten.** Commercieel: de avatar is 60–80% van de variabele kosten, dus een
prijsverandering raakt de marge direct. Juridisch: Beyond Presence documenteert de eigen
marketingstack tot in detail maar zegt niets over de sessiedata — geen opslaglocatie,
geen bewaartermijn, geen trainingsverklaring, geen biometrieclausule. Voor een bedrijf
dat "fully GDPR compliant" als hoofddifferentiator voert, is dat de opvallendste
omissie, en het is precies wat een compliance-officer van een advocatenkantoor als
eerste vraagt.

**Mitigatie in de code.** `AvatarProvider` is audio-first: wij leveren PCM, de vendor
rendert alleen het gezicht. Daardoor blijven STT, LLM, TTS en dus de Nederlandse
stemkwaliteit én de latency in eigen hand, en is wisselen een configuratieregel. Fase 1
bouwt bewust twee providers achter dezelfde interface, niet één.

**Mitigatie buiten de code.** Vóór er één echte cliënt op zit: DPA met verwerkingslocatie
in de EU, expliciet trainingsverbod, bewaartermijn ≤ 24 uur voor audio/video,
subverwerkerslijst, auditrecht. Blijkt dat niet haalbaar, dan is Anam binnen een dag de
vervanger — mits die tweede provider daadwerkelijk gebouwd is, en niet alleen als
mogelijkheid genoemd.

---

## 5. Kostengedreven misbruik van de publieke intakeroute

**Waarom dit reëel is.** Elke sessie kost echt geld vanaf de eerste seconde: ~$2–3 per
intake van twaalf minuten, waarvan het leeuwendeel avatar-minuten. Een openbare URL die
per aanroep een avatarsessie start, is een rekening die iemand anders kan opvoeren.

**Mitigatie.** `app.check_and_bump_rate_limit()` telt pogingen per gehashte IP én per
organisatie (standaard 5 per uur), en `app.create_public_intake` weigert daarboven.
`organizations.session_limits` legt maximale sessieduur (25 min),
inactiviteitstimeout (90 s), gelijktijdige sessies en een maandbudget per tenant vast.
Bij budgetoverschrijding valt het systeem terug op chat in plaats van te weigeren — een
dichte deur kost een cliënt, een chatgesprek niet.

**Nog te doen.** Een bot-check vóór sessiecreatie, en de daadwerkelijke budgetbewaking op
basis van `sessions.billed_seconds` en `llm_calls`. Die tellers staan er; de handhaving
volgt in Fase 6.
