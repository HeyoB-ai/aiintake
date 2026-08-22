# DPIA-input

Werkdocument, geen DPIA. Dit verzamelt wat een gegevensbeschermingseffectbeoordeling
nodig heeft; de beoordeling zelf hoort door een functionaris of jurist te worden gedaan.

**Status:** opgezet in Fase 0, af te maken in Fase 7. Onvolledige onderdelen zijn als
zodanig gemarkeerd — een DPIA met stille gaten is erger dan een DPIA met open vragen.

---

## 1. Waarom een DPIA waarschijnlijk verplicht is

Drie factoren komen samen:

- **Bijzondere persoonsgegevens (art. 9 AVG).** Arbeidsrechtelijke intakes gaan
  structureel over ziekte, bedrijfsarts en re-integratie. Dat is gezondheidsdata, en het
  komt ongevraagd binnen — de cliënt vertelt het omdat het relevant is, niet omdat er
  naar gevraagd wordt. In de feitcatalogus zijn deze sleutels gemarkeerd
  (`SPECIAL_CATEGORY_FACT_KEYS`): `currently_ill`, `sick_since`,
  `occupational_doctor_involved`, `reintegration_dispute`.
- **Innovatieve technologie.** Realtime AI-avatar, spraakherkenning, LLM-verwerking.
- **Systematische observatie.** Een gesprek dat wordt getranscribeerd en geanalyseerd.

Daarnaast: stem is een persoonsgegeven, en gezicht zou dat zijn als het apparaat werd
verlaten — wat het niet doet, zie §4.

## 2. Verwerkingen

| Verwerking                 | Grondslag                                    | Categorieën                         | Bewaartermijn                                             |
| -------------------------- | -------------------------------------------- | ----------------------------------- | --------------------------------------------------------- |
| Intakegesprek (transcript) | toestemming + gerechtvaardigd belang kantoor | identificatie, arbeid, gezondheid   | `transcriptRetentionDays`, default 365                    |
| Audio (STT)                | toestemming                                  | stem                                | niet bewaard door ons; vendorretentie contractueel ≤ 24 u |
| Video (avatar-rendering)   | toestemming                                  | — (alleen assistentvideo)           | niet bewaard                                              |
| Cliëntcamera               | toestemming, optioneel                       | gezicht                             | **verlaat het apparaat niet** (ADR-0004)                  |
| Visuele signalen           | toestemming                                  | booleans over aanwezigheid/beweging | efemeer, default 0 uur                                    |
| Documenten                 | toestemming                                  | wat de cliënt uploadt               | `documentRetentionDays`, default 365                      |
| Feiten en samenvatting     | gerechtvaardigd belang kantoor               | arbeid, gezondheid                  | volgt transcript                                          |
| Auditlog                   | wettelijke verplichting / verantwoording     | id's, geen inhoud                   | af te bakenen — **open**                                  |
| Latencymetriek             | gerechtvaardigd belang                       | geen persoonsgegevens               | onbeperkt                                                 |

## 3. Subverwerkers

De keten is de zwakste schakel: vier verwerkers die allemaal een DPA nodig hebben met
EU-verwerking, trainingsverbod en een bewaartermijn. Zonder dat kan geen enkel
Nederlands kantoor dit contracteren.

| Rol                  | Kandidaat                       | Locatie        | DPA      | Trainingsverbod                          | Retentie            |
| -------------------- | ------------------------------- | -------------- | -------- | ---------------------------------------- | ------------------- |
| Avatar               | Beyond Presence (DE)            | EU             | **open** | **open — beleid zwijgt over sessiedata** | **open**            |
| Avatar (alternatief) | Anam (UK)                       | EU-endpoints   | open     | ZDR op Enterprise                        | open                |
| STT                  | Deepgram                        | te bevestigen  | open     | open                                     | open                |
| TTS                  | Cartesia / ElevenLabs           | te bevestigen  | open     | open                                     | open                |
| LLM                  | Anthropic via EU-regio-endpoint | EU             | open     | open                                     | open                |
| Database/opslag      | Supabase                        | EU-regio (eis) | open     | n.v.t.                                   | onder onze controle |
| Transport            | LiveKit                         | EU             | open     | n.v.t.                                   | geen opslag         |

**Actie vóór de eerste echte cliënt:** elk vakje in deze tabel gevuld, met
verwerkingslocatie in de EU, expliciet trainingsverbod, bewaartermijn ≤ 24 uur voor
audio/video, subverwerkerslijst en auditrecht.

## 4. Technische en organisatorische maatregelen

Wat al in de code zit:

- **Geen videoframes verlaten het apparaat voor analyse.** Browser-side MediaPipe;
  alleen booleans over de datachannel. De cliëntcamera wordt standaard niet naar de room
  gepubliceerd (ADR-0004).
- **Geen emotieherkenning.** Geen implementatie, geen feature flag (ADR-0005).
- **Tenantisolatie via RLS** op elke tabel, met een testsuite die het bewijst
  (uitvoering: zie [RISICOS.md](RISICOS.md) risico 3).
- **De agent-worker heeft geen sleutel die verder reikt dan één intake** (ADR-0002).
- **Geen persoonsgegevens in applicatielogs.** De logger filtert bekende gevoelige
  velden en kapt lange vrije tekst af; getest in `apps/agent/src/log.test.ts`.
- **Toestemming apart vastgelegd** voor privacyverklaring en AI-disclosure, met
  versienummer van beide teksten, in dezelfde transactie als de intake.
- **Auditlog is append-only**: geen update- of delete-policy, ook niet voor een
  beheerder.
- **Documenten alleen via signed URLs met korte TTL**, private bucket, tenant-id als
  eerste padcomponent.
- **Prompt-injectieverdediging**: documentinhoud komt nooit op het hot path en wordt
  altijd tussen delimiters als data aangeboden.

Nog te bouwen: retentie-cleanup (Fase 6), conflictcheck vóór afronding (Fase 6),
versleuteling van bijzondere velden at rest boven de standaard schijfversleuteling
(**open — te beoordelen of dit proportioneel is**).

## 5. Transparantie

De AI Act verplicht dat een systeem dat met mensen interacteert zich als zodanig
bekendmaakt. Praktisch:

- De avatar introduceert zichzelf als AI-intake-assistent.
- Het label _AI-assistent_ blijft permanent en discreet in beeld — niet alleen één zin
  bij de start.
- De welkomsttekst zegt expliciet: "U spreekt met een AI-assistent en niet met een
  advocaat. De assistent geeft geen juridisch advies."
- Elke samenvatting sluit af met een disclaimer die stelt dat het om een AI-gegenereerde
  intakesamenvatting gaat die juridische beoordeling vereist.

## 6. Vertrouwelijkheid vóór opdracht

Formeel is een intake vóór mandaat niet door het verschoningsrecht gedekt. De cliënt
gaat daar wél van uit en vertelt navenant. Behandel de data daarom alsof zij bevoorrecht
is: versleuteling at rest, korte TTL op signed URLs, geen persoonsgegevens in logs,
retentie per kantoor instelbaar, en een conflictcheck vóórdat een intake als afgerond
wordt gemarkeerd — een kantoor dat de wederpartij al bijstaat, mag dit dossier niet
inzien.

## 7. Rechten van betrokkenen

**Open.** Uit te werken in Fase 6: inzage, rectificatie (de advocaat kan feiten al
corrigeren via `case_facts` met `source = 'lawyer_input'`), verwijdering, en de vraag
wie het aanspreekpunt is — het kantoor als verwerkingsverantwoordelijke, of wij als
verwerker.
