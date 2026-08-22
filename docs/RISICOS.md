# Technische risico's

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

## 2. De STT knipt een uitspraak doormidden en niemand merkt het

**Dit is geen latencyprobleem.** Het staat los van het budget en hoort niet als
bijvangst van endpointing behandeld te worden, want de schade is van een andere soort:
bij latency wordt het gesprek traag, hier wordt de intake **stil onjuist**.

**Wat er gebeurt.** Deepgram besluit op basis van een stiltedrempel dat de cliënt is
uitgesproken (`speech_final`) terwijl die nog midden in een zin zit. Wij sluiten de
beurt af met wat er tot dan toe binnenkwam. De rest van de zin komt daarna alsnog
binnen, maar de engine heeft de beurt al verwerkt.

Waargenomen op **1 van de 4 runs**, op schone synthetische spraak zonder aarzeling:

```
gezegd:      "Ik kreeg gisteren een vaststellingsovereenkomst van mijn werkgever."
verwerkt:    "Ik kreeg gisteren een vaststellingsovereenkomst"
```

**Waarom dit erger is dan het lijkt.** De engine denkt te hebben gehoord wat er nooit
binnenkwam. Er is geen foutmelding, geen lege waarde, geen twijfelsignaal — alleen een
zin die grammaticaal klopt en inhoudelijk incompleet is. Dat werkt door:

- de assistent beantwoordt een half gehoorde vraag, en klinkt daarbij volkomen zeker;
- de fact extraction ziet een uitspraak zonder de bepaling die hem betekenis gaf
  ("van mijn werkgever", "sinds maart", "nog niet");
- de samenvatting neemt dat over als vastgesteld feit, met bronverwijzing en al — want
  het citaat _staat_ letterlijk in het transcript;
- de advocaat leest een samenvatting die klopt met de brondata en toch niet met wat de
  cliënt zei.

De ingebouwde controles vangen dit niet. `rejectUngroundedFacts` controleert of een
feit in het transcript staat, niet of het transcript compleet is. Een afgekapte zin is
een perfect verankerde bron.

**Wat het gevaarlijkst maakt:** dit degradeert niet zichtbaar. Een systeem dat vastloopt
merk je; een systeem dat elke twintigste zin halveert, merk je pas als een advocaat op
een verkeerd feit afgaat.

**Mitigatie, gebouwd.** De STT-laag detecteert nu een te vroege knip: komen er na een
`speech_final` woorden binnen die tijdgewijs aansluiten op de vorige, dan hoorden ze bij
dezelfde uitspraak. Deepgram's `UtteranceEnd` levert daarnaast een eigen `last_word_end`;
ligt die ná het punt waarop wij afkapten, dan is dat een tweede, onafhankelijk signaal.
De lus behandelt zo'n geval als wat het is — de cliënt was nog aan het woord — en breekt
het antwoord af in plaats van een halve vraag te beantwoorden.

**Mitigatie, nog te doen.**

- Het signaal persisteren, zodat "hoe vaak knippen we verkeerd" een meetbare waarde
  wordt en geen indruk. Vraagt een kolom op `messages`; staat in de roadmap.
- Meten op echte spraak met aarzeling. Op synthetische audio is het 1 op 4; bij "eh" en
  wegstervende zinnen wordt dat vaker, niet minder.
- De afweging maken die daarna volgt: `endpointing` omhoog kost latencybudget maar
  verlaagt het dataverlies. Dat is een productbeslissing, geen instelling — en met deze
  detectie erbij is hij voor het eerst met cijfers te nemen in plaats van op gevoel.

---

## 3. Barge-in werkt "wel", maar het transcript klopt niet

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

## 4. ~~De tenantgrens is geschreven maar niet bewezen~~ — GESLOTEN, 22 augustus 2026

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

## 5. Vendorafhankelijkheid, in het bijzonder de avatarleverancier

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

## 6. Kostengedreven misbruik van de publieke intakeroute

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
