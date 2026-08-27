import {
  EMPLOYMENT_CATALOG,
  FactExtractionModelResultSchema,
  describeClaim,
  findArithmeticClaim,
  isContentlessAffirmation,
  type ExtractedFact,
  type FactExtractionModelResult,
  rejectUngroundedFacts,
  type CaseFactMap,
  type FactCatalog,
  type FactDefinition,
  resolveWeekdag,
  vindWeekdagVerwijzing,
  openingsZin,
} from '@intake/domain';
import {
  dagdeelGroet,
  datumAnker,
  PROMPTS,
  practiceAreaLabel,
  render,
  type RenderedPrompt,
} from '@intake/prompts';

/**
 * Doorgegeven, zodat een aanroeper de sleutel en versie voor `llm_calls` kan vastleggen
 * zonder zelf aan `@intake/prompts` te hoeven hangen. De worker hoort niet te weten dat
 * promptsjablonen bestaan; hij hoort alleen te weten wat hij moet loggen.
 */
export type { RenderedPrompt };
import { scoreCompleteness } from './completeness';
import { evaluate } from './conditions';
import { planQuestions } from './planner';
import { isBeantwoord, isRelevant, relevanteCategorieen } from './relevantie';
import { evaluateRules } from './rules';
import type {
  LadingOordeel,
  EngineDecision,
  EngineInput,
  FactUpdate,
  IntakeConversationEngine,
  ObservationResult,
  RejectedFact,
} from './types';

/**
 * De IntakeConversationEngine.
 *
 * Twee sporen die bewust niet op elkaar wachten.
 *
 * `respond()` is het **hot path**. Het levert platte tekst, gestreamd per zin, want je
 * kunt geen half-afgemaakt JSON-veld uitspreken. Alles wat hier gebeurt telt mee in het
 * latencybudget, dus er is geen validatie, geen retry en geen tweede modelaanroep.
 *
 * `observe()` is het **cold path**. Het draait na de beurt, blokkeert niets, en mag
 * daarom wél een gesloten schema, validatie en een herstelpoging hebben. Eén beurt
 * vertraging in feitenkennis is acceptabel: de planner werkt met de feiten van beurt
 * N−1 terwijl het hot-path model het ruwe transcript ziet, dus de cliënt merkt er niets
 * van.
 *
 * De engine kent geen HTTP, geen WebRTC en geen leverancier. De modellen komen binnen
 * als poorten. Daardoor draait dezelfde intake-intelligentie in videomodus en in de
 * chat-fallback, en is dit bestand te testen zonder één netwerkcall.
 */

/** Het hot-path model. Streamt tekst; de engine wacht nooit op het geheel. */
export interface HotPathModel {
  stream(request: {
    readonly system: string;
    readonly history: readonly { role: 'client' | 'assistant'; content: string }[];
    readonly lastClientUtterance?: string;
  }): AsyncIterable<string>;
}

/** Het cold-path model. Levert ruwe tekst; de engine valideert zelf. */
export interface ColdPathModel {
  complete(request: {
    readonly system: string;
    readonly user: string;
    /** Tweede poging na een schemafout, met de fout erbij. */
    readonly repairOf?: { readonly previous: string; readonly error: string };
  }): Promise<string>;
}

export interface EngineDeps {
  readonly hot: HotPathModel;
  readonly cold: ColdPathModel;
  /**
   * Het model dat de lading van één cliëntuitspraak beoordeelt.
   *
   * Optioneel: zonder dit draait de lus precies zoals daarvoor, zonder erkenningen. Dat is
   * geen degradatiepad maar een keuze die een kantoor kan maken — en het houdt elke
   * bestaande test die geen erkenning verwacht, groen om de goede reden.
   */
  readonly classify?: ClassifyModel;
  /** Het ladingoordeel liep stuk. Nooit stil: zie de toelichting bij `respond`. */
  readonly onLadingFout?: (fout: unknown) => void;
  /**
   * De openingsbeurt wordt gebouwd; dit is wat er op dat moment bekend was.
   *
   * Bestaat omdat een ontbrekende naam anders alleen hoorbaar is. Wie meeluistert merkt
   * het; wie het log leest niet.
   */
  readonly onOpening?: (info: {
    clientName: string | null;
    organisationName: string;
    turnCount: number;
  }) => void;
  /** Een tweede verbinding met een lopende intake. Zie hervatting.ts. */
  readonly onHervatting?: (info: { clientName: string | null; turnCount: number }) => void;
  readonly catalog?: FactCatalog;
  /** Waar de gerenderde prompt naartoe gaat voor `llm_calls`. Optioneel. */
  readonly onPrompt?: (prompt: RenderedPrompt) => void;
  /**
   * Hoeveel beurten de cliënt vrij mag vertellen voordat de planner gaat sturen.
   *
   * Instelbaar zodat het effect te méten is in plaats van te beweren. Nul zet de
   * narratieve fase uit en levert het gedrag van vóór v4: meteen de kandidatenlijst
   * afwerken.
   */
  readonly narrativeTurns?: number;
  /**
   * Een datum die het vangnet heeft rechtgezet.
   *
   * Zichtbaar maken en niet stil corrigeren: een correctie die nergens landt, is niet te
   * onderscheiden van een controle die niets doet. Gaat naar de HUD en naar `llm_calls`.
   */
  readonly onWeekdayCorrection?: (correctie: {
    key: string;
    van: unknown;
    naar: string;
    uitspraak: string;
  }) => void;
}

/** Hoeveel beurten er minimaal tussen twee overbruggingszinnen zitten. */
const FILLER_INTERVAL = 3;

/**
 * Beurten waarin de cliënt vrij vertelt en de assistent oogst in plaats van afvinkt.
 *
 * Drie beurten is ongeveer een minuut. Kort genoeg dat de must-haves niet in gevaar
 * komen, lang genoeg dat iemand zijn verhaal kwijt kan — en dat is precies wat een intake
 * onderscheidt van een formulier. Een cliënt die zijn verhaal niet heeft kunnen doen,
 * beantwoordt de rest korter en minder volledig.
 */
const NARRATIVE_TURNS = 3;

/**
 * Eén korte, gestructureerde aanroep. Geen streaming: er valt niets uit te spreken.
 */
export interface ClassifyModel {
  complete(req: { system: string; user: string }): Promise<string>;
}

/**
 * Het ladingoordeel ophalen en streng lezen.
 *
 * Alles wat niet exact aan het schema voldoet, wordt `null` — en `null` betekent zwijgen.
 * Dat is de veilige kant: een onleesbaar antwoord mag nooit tot een erkenning leiden die
 * niemand heeft bedoeld. Er is bewust geen reparatiepoging zoals op het koude pad; dit
 * draait op het spraakpad en een tweede aanroep zou het antwoord ophouden.
 */
async function beoordeelLading(
  deps: EngineDeps,
  input: EngineInput,
): Promise<LadingOordeel | null> {
  const uitspraak = input.lastClientUtterance?.trim();
  if (!uitspraak || !deps.classify) return null;

  const prompt = render(PROMPTS.lading, { utterance: uitspraak }, input.language);
  deps.onPrompt?.(prompt);

  const rauw = await deps.classify.complete({ system: prompt.body, user: uitspraak });
  const gelezen = parseJson(rauw);
  if (!gelezen.ok) return null;

  const o = gelezen.value as Record<string, unknown>;
  const lading = o['lading'];
  if (lading !== 'geen' && lading !== 'persoonlijk' && lading !== 'zwaar') return null;

  return {
    lading,
    wanhoop: o['wanhoop'] === 'acuut' || o['wanhoop'] === 'geldzorgen' ? o['wanhoop'] : 'geen',
    // Alleen overnemen als het model een woord teruggaf. Alles anders wordt null, want
    // een gevoel dat de cliënt niet heeft geuit mag nergens vandaan komen.
    geuitGevoel:
      typeof o['geuitGevoel'] === 'string' && o['geuitGevoel'].trim() !== ''
        ? o['geuitGevoel'].trim()
        : null,
  };
}

export function createIntakeEngine(deps: EngineDeps): IntakeConversationEngine {
  const catalog = deps.catalog ?? EMPLOYMENT_CATALOG;
  const narrativeTurns = deps.narrativeTurns ?? NARRATIVE_TURNS;

  return {
    async respond(input: EngineInput): Promise<EngineDecision> {
      const turnCount = input.history.length;
      const plan = planQuestions({
        catalog,
        template: input.template,
        rules: input.rules,
        facts: input.facts,
        turnCount,
        language: input.language,
        now: input.now,
        pendingLawyerRequests: input.pendingLawyerRequests,
      });

      // Deterministisch, vóór het model. Twaalf maal twaalfduizend is
      // honderdvierenveertigduizend, ongeacht wat een model ervan vindt — dus dat oordeel
      // hoort niet aan het model gevraagd te worden maar eraan meegegeven.
      const somFout = input.lastClientUtterance
        ? findArithmeticClaim(input.lastClientUtterance)
        : null;

      const isOpening = turnCount === 0 && !input.lastClientUtterance;
      /*
       * Een tweede verbinding met een intake die al liep.
       *
       * Geen nieuw veld nodig: een gewone beurt heeft altijd een cliëntuitspraak, en de
       * lus roept `open()` alleen aan bij het begin van een sessie. Dus "geen uitspraak
       * maar wél geschiedenis" is precies de hervatting.
       */
      const isHervatting = turnCount > 0 && !input.lastClientUtterance;

      /*
       * Melden wat er beschikbaar was op het moment dat de opening werd gebouwd.
       *
       * Niet achteraf uit het transcript af te leiden: een opening zonder naam ziet er
       * daar hetzelfde uit als een cliënt die geen naam heeft ingevuld. En dit is de enige
       * beurt waarin de naam wordt gebruikt, dus als hij hier ontbreekt, ontbreekt hij het
       * hele gesprek.
       */
      if (isOpening) {
        deps.onOpening?.({
          clientName: input.clientName ?? null,
          organisationName: input.organization.name,
          turnCount,
        });
      }
      if (isHervatting) {
        deps.onHervatting?.({ clientName: input.clientName ?? null, turnCount });
      }
      const isClosing = plan.shouldClose && !isOpening;
      const narrativePhase = !isClosing && turnCount <= narrativeTurns * 2;

      // Pacing. De overbruggingszin is een middel tegen stilte, geen stijlkenmerk:
      // vaker dan eens per drie beurten en het wordt een tic die opvalt.
      const allowFiller =
        !isOpening && !isClosing && turnCount > 0 && turnCount % FILLER_INTERVAL === 0;
      // In de narratieve fase iets meer ruimte: een uitnodiging om te vertellen kost
      // een zin meer dan een gesloten vraag.
      // De opening heeft er vier nodig: drie voor wie/wat/waarom, en één voor de vraag.
      // Met drie sneuvelt er een van de vier verplichte punten, en dat is meestal
      // uitgerekend "ik ben geen advocaat".
      const maxSentences = isClosing ? 2 : isOpening ? 4 : narrativePhase ? 3 : 2;

      const prompt = render(
        PROMPTS.conversation,
        {
          organisationName: input.organization.name,
          practiceAreaLabel: practiceAreaLabel(input.language),
          candidates: plan.candidates.map((c) => ({
            factKey: c.factKey,
            label: c.label,
            hint: c.hint,
          })),
          knownFacts: bekendeFeiten(catalog, input.facts, input.language),
          maxSentences,
          allowFiller,
          ...(input.interruptedPrefix ? { interruptedPrefix: input.interruptedPrefix } : {}),
          ...(input.pendingLawyerRequests.length > 0
            ? { lawyerRequests: input.pendingLawyerRequests }
            : {}),
          isOpening,
          isResuming: isHervatting,
          isClosing,
          narrativePhase,
          clientName: input.clientName ?? null,
          // De klok zit al in `input.now`; de groet hoort daaruit te volgen en niet uit
          // het model, dat er geen heeft en "Goedemorgen" om acht uur 's avonds koos.
          greeting: dagdeelGroet(input.now, input.language, input.organization.timeZone),
          ...(somFout && !somFout.correct
            ? { arithmeticWarning: describeClaim(somFout, input.language) }
            : {}),
        },
        input.language,
      );
      deps.onPrompt?.(prompt);

      /*
       * De opening gaat niet langs het model.
       *
       * De prompt gaf het model een letterlijk sjabloon en het reproduceerde dat teken voor
       * teken: 338 tekens gemeten in productie, 338 in het sjabloon. Er werd dus een aanroep
       * gedaan om een vaste tekst terug te krijgen — op de beurt waarop de cliënt het langst
       * wacht, en met het risico dat een model dat één keer níét reproduceert de disclaimer
       * afzwakt of weglaat (risico 17).
       *
       * Dezelfde redenering als bij de erkenning, de wanhoopsreactie en de hervatting: het
       * model beoordeelt, de woorden liggen vast. Hier valt er niet eens iets te beoordelen —
       * dat dit de opening is, weet de lus zelf. Zie @intake/domain/opening.ts.
       */
      if (isOpening) {
        const zin = openingsZin(
          {
            greeting: dagdeelGroet(input.now, input.language, input.organization.timeZone),
            clientName: input.clientName ?? null,
            organisationName: input.organization.name,
          },
          input.language,
        );
        return {
          isResuming: false,
          intent: 'ask',
          speak: (async function* () {
            yield zin;
          })(),
          plannedQuestionKeys: plan.candidates.map((c) => c.factKey),
          pacing: { allowFiller, maxSentences },
        };
      }

      const speak = deps.hot.stream({
        system: prompt.body,
        // 'system'-beurten zijn interne notities en horen niet in de gespreksgeschiedenis
        // die het model als dialoog leest.
        history: input.history
          .filter((t): t is typeof t & { role: 'client' | 'assistant' } => t.role !== 'system')
          .map((t) => ({ role: t.role, content: t.content })),
        ...(input.lastClientUtterance ? { lastClientUtterance: input.lastClientUtterance } : {}),
      });

      /*
       * De erkenning, náást de generatie en nooit ervóór.
       *
       * Het oordeel over de lading is een tweede modelaanroep. Die vóór de generatie zetten
       * zou elke beurt de tijd tot het eerste woord verlengen met een hele aanroep — op een
       * budget dat al krap is. Dus draaien ze tegelijk, en geldt één regel: de erkenning mag
       * het antwoord nooit ophouden. Is het oordeel er vóór de eerste zin van het model, dan
       * gaat hij ervoor; is hij er niet, dan zwijgt de assistent en gaat het gesprek gewoon
       * door.
       *
       * Dat betekent dat de erkenning soms uitblijft terwijl hij had gemogen. Dat is de
       * goede kant om fout te zitten: een gemiste erkenning is een gesprek dat iets zakelijker
       * verloopt, een vertraagd antwoord is een gesprek dat hapert.
       */
      const ladingBelofte = deps.classify
        ? beoordeelLading(deps, input).catch((fout) => {
            deps.onLadingFout?.(fout);
            return null;
          })
        : null;

      return {
        isResuming: isHervatting,
        ...(ladingBelofte ? { lading: ladingBelofte } : {}),
        intent: isClosing
          ? 'close'
          : isOpening
            ? 'ask'
            : plan.candidates.length > 0
              ? 'ask'
              : 'acknowledge',
        speak,
        plannedQuestionKeys: plan.candidates.map((c) => c.factKey),
        pacing: { allowFiller, maxSentences },
      };
    },

    async observe(input: EngineInput): Promise<ObservationResult> {
      // Zonder nieuwe spraak valt er niets te extraheren, en dan is een modelaanroep
      // alleen kosten. De score en de regels rekenen we wél opnieuw: die hangen ook van
      // de klok af, en een deadline die vannacht dichterbij kwam moet vanochtend zichtbaar
      // zijn zonder dat de cliënt eerst iets hoeft te zeggen.
      const { transcript, clientOnly } = nieuweBeurten(input);
      if (!transcript.trim()) {
        return beoordeel(input, [], catalog);
      }

      const gezocht = gezochteFeiten(catalog, input.facts);
      const prompt = render(
        PROMPTS.extraction,
        {
          transcript,
          wantedFacts: gezocht.map((f) => ({
            key: f.key,
            label: f.label[input.language],
            valueType: f.valueType,
            ...(f.enumValues ? { enumValues: f.enumValues } : {}),
          })),
          knownFacts: Object.entries(input.facts)
            .filter(([, v]) => v?.status === 'confirmed')
            .map(([k, v]) => ({ key: k, value: String(v?.value ?? '') })),
          // Het anker in de zone van het kantoor, met weekdag erbij. `toISOString()`
          // stond hier eerder en gaf de UTC-datum: 's nachts een dag mis.
          anker: datumAnker(input.now, input.language, input.organization.timeZone),
        },
        input.language,
      );
      deps.onPrompt?.(prompt);

      const { updates, rejected, error } = await extraheer(
        deps.cold,
        prompt.body,
        transcript,
        clientOnly,
        catalog,
        gezocht,
      );

      /*
       * Tweede ronde over dezelfde beurt, voor wat er nét is vrijgekomen.
       *
       * De conditionele categorieën worden bepaald met de feiten van vóór deze beurt. Zegt
       * de cliënt alles in één adem — "ik ben afgelopen vrijdag op staande voet ontslagen" —
       * dan stelt deze extractie `termination_route` vast, maar `summary_dismissal_date`
       * stond niet in de zoeklijst omdat die route toen nog niet bekend wás. En omdat het
       * transcript alleen de beurten sinds de vorige extractie bevat, is die vrijdag daarna
       * weg: hij wordt nooit meer gezocht.
       *
       * Gemeten: in één beurt kwam de ontslagdatum er niet uit, in twee beurten wel. Dat is
       * geen tekortkoming van het model maar van onze volgorde.
       *
       * Eén extra ronde, niet in een lus. Twee ronden dekken "conditie en waarde in dezelfde
       * adem"; een categorie die pas door een feit uit ronde twee vrijkomt is zeldzaam
       * genoeg om de volgende beurt af te wachten, en een lus zou de kosten van het koude
       * pad onbegrensd maken.
       */
      // `FactUpdate` draagt geen `llmCallId`; die vult de opslag later. Voor het opnieuw
      // wegen van de conditionele categorieën doen alleen sleutel, waarde en status ertoe.
      const naEersteRonde: CaseFactMap = {
        ...input.facts,
        ...Object.fromEntries(
          updates.map((f) => [f.key, { ...f, llmCallId: null } as CaseFactMap[string]]),
        ),
      };
      const nieuwVrijgekomen = gezochteFeiten(catalog, naEersteRonde).filter(
        (f) => !gezocht.some((g) => g.key === f.key),
      );

      let alleUpdates = updates;
      let alleGeweigerd = rejected;
      if (nieuwVrijgekomen.length > 0) {
        const tweede = render(
          PROMPTS.extraction,
          {
            transcript,
            wantedFacts: nieuwVrijgekomen.map((f) => ({
              key: f.key,
              label: f.label[input.language],
              valueType: f.valueType,
              ...(f.enumValues ? { enumValues: f.enumValues } : {}),
            })),
            knownFacts: Object.entries(naEersteRonde)
              .filter(([, v]) => v?.status === 'confirmed')
              .map(([k, v]) => ({ key: k, value: String(v?.value ?? '') })),
            anker: datumAnker(input.now, input.language, input.organization.timeZone),
          },
          input.language,
        );
        deps.onPrompt?.(tweede);
        const extra = await extraheer(
          deps.cold,
          tweede.body,
          transcript,
          clientOnly,
          catalog,
          nieuwVrijgekomen,
        );
        alleUpdates = [...updates, ...extra.updates];
        alleGeweigerd = [...rejected, ...extra.rejected];
      }

      const gecorrigeerd = corrigeerWeekdagen(
        alleUpdates,
        datumAnker(input.now, input.language, input.organization.timeZone),
        input.language,
        deps.onWeekdayCorrection,
      );

      return {
        ...beoordeel(input, gecorrigeerd, catalog),
        factUpdates: gecorrigeerd,
        rejectedFacts: alleGeweigerd,
        ...(error ? { extractionError: error } : {}),
      };
    },
  };
}

/**
 * Score en urgentie, gerekend ná de extractie van déze beurt.
 *
 * Eerst stond dit vóór de extractie, en dat betekende dat de feiten uit de zojuist
 * verwerkte beurt pas een ronde later meetelden. Voor de volledigheidsscore is dat
 * hinderlijk; voor de urgentieregels is het fout. Een cliënt die in zijn laatste zin een
 * tekendeadline noemt, zou dan nooit een CRITICAL opleveren — de intake eindigt en de
 * regel is nooit gedraaid.
 *
 * De planner mag wél een beurt achterlopen; dat is een bewuste keuze en staat los hiervan.
 * Wat je terugmeldt over urgentie hoort te gaan over alles wat je weet.
 */
function beoordeel(
  input: EngineInput,
  updates: readonly FactUpdate[],
  catalog: FactCatalog,
): ObservationResult {
  const samen: Record<string, CaseFactMap[string]> = { ...input.facts };
  for (const u of updates) {
    samen[u.key] = {
      key: u.key,
      value: u.value,
      valueType: u.valueType,
      status: u.status,
      confidence: u.confidence,
      source: u.source,
      sourceRef: u.sourceRef || null,
      llmCallId: null,
      updatedAt: input.now.toISOString(),
    };
  }

  const completeness = scoreCompleteness(samen, input.template, catalog);
  return {
    factUpdates: updates,
    riskFlags: evaluateRules(input.rules, samen, input.now, input.language).map((r) => ({
      ruleKey: r.ruleKey,
      level: r.level,
      label: r.label,
    })),
    completeness: completeness.score,
    missingRequiredKeys: completeness.missingRequiredKeys,
    topicsTouched: completeness.topicsTouched,
    topicsRelevant: completeness.topicsRelevant,
  };
}

/**
 * Extractie met één herstelpoging.
 *
 * De tweede poging krijgt de vorige uitvoer én de foutmelding mee. Dat werkt beter dan
 * dezelfde vraag nog eens stellen: een model dat zijn eigen schemafout ziet, herstelt hem
 * meestal, terwijl een blinde herhaling dezelfde fout oplevert.
 *
 * Mislukt ook de tweede poging, dan levert deze functie een lege lijst en geen exception.
 * Het koude pad mag het gesprek niet omgooien — een gemiste extractie kost één beurt
 * feitenkennis, een crash kost de hele intake.
 */
async function extraheer(
  cold: ColdPathModel,
  system: string,
  transcript: string,
  clientOnly: string,
  catalog: FactCatalog,
  gezocht: readonly FactDefinition[],
): Promise<{
  updates: readonly FactUpdate[];
  rejected: readonly RejectedFact[];
  error?: string;
}> {
  const user = 'Geef de feiten die je in het transcript vindt.';
  let ruw = await cold.complete({ system, user });

  for (let poging = 0; poging < 2; poging += 1) {
    const geparsed = parseJson(ruw);
    if (geparsed.ok) {
      const gevalideerd = FactExtractionModelResultSchema.safeParse(geparsed.value);
      if (gevalideerd.success) {
        return naarFactUpdates(gevalideerd.data, transcript, clientOnly, catalog, gezocht);
      }
      if (poging === 1) {
        return { ...LEEG, error: `schema niet gehaald: ${kortIssue(gevalideerd.error)}` };
      }
      ruw = await cold.complete({
        system,
        user,
        repairOf: { previous: ruw, error: gevalideerd.error.message.slice(0, 800) },
      });
      continue;
    }
    if (poging === 1) return { ...LEEG, error: `geen geldige JSON: ${geparsed.error}` };
    ruw = await cold.complete({
      system,
      user,
      repairOf: { previous: ruw, error: geparsed.error },
    });
  }
  return LEEG;
}

const LEEG = { updates: [] as readonly FactUpdate[], rejected: [] as readonly RejectedFact[] };

/** De eerste paar veldfouten; de volledige Zod-melding is te lang voor een HUD-regel. */
function kortIssue(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join(' | ');
}

function parseJson(tekst: string): { ok: true; value: unknown } | { ok: false; error: string } {
  // Modellen zetten er soms een codeblok omheen, ook als je erom vraagt het te laten.
  const schoon = tekst
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return { ok: true, value: JSON.parse(schoon) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'ongeldige JSON' };
  }
}

/**
 * Van modeluitvoer naar feitupdates, met drie zeven.
 *
 * Verankering, dan bekende sleutel, dan het type. Alle drie zijn nodig: een citaat dat
 * niet in het transcript staat is verzonnen, een sleutel die niet in de catalogus staat
 * kan nooit worden opgeslagen, en een waarde die de validator niet haalt zou als "feit"
 * in de samenvatting belanden met de verkeerde betekenis.
 */
function naarFactUpdates(
  resultaat: FactExtractionModelResult,
  transcript: string,
  clientOnly: string,
  catalog: FactCatalog,
  gezocht: readonly FactDefinition[],
): { updates: readonly FactUpdate[]; rejected: readonly RejectedFact[] } {
  const toegestaan = new Map(gezocht.map((f) => [f.key, f]));

  // De mechanische velden vullen wij, niet het model: `valueType` staat in de catalogus,
  // `source` is bij transcriptextractie per definitie een cliëntuitspraak, en `sourceRef`
  // weten wij. Zie ExtractedFactDraftSchema voor waarom dat er niet bij het model hoort.
  const volledig: ExtractedFact[] = [];
  for (const draft of resultaat.facts) {
    const definitie = toegestaan.get(draft.key) ?? catalog.facts.find((f) => f.key === draft.key);
    // Een sleutel die niet in de catalogus staat kan nooit worden opgeslagen; die valt
    // hier af in plaats van verderop stilletjes.
    if (!definitie) continue;
    volledig.push({
      key: draft.key,
      value: draft.value,
      valueType: definitie.valueType,
      status: draft.status,
      confidence: draft.confidence,
      source: 'client_statement',
      sourceRef: 'transcript',
      evidenceQuote: draft.evidenceQuote,
    });
  }

  // Verankeren tegen wat de CLIËNT zei, niet tegen het hele gesprek.
  const { accepted: verankerd, rejected } = rejectUngroundedFacts(volledig, clientOnly);

  // Voor de melding: stond het citaat wél in het gesprek maar niet bij de cliënt, dan is
  // het uit een assistent-beurt overgenomen. Dat is een andere fout dan een verzonnen
  // citaat, en hij hoort ook anders te heten — anders zoek je bij een verkeerde melding
  // naar hallucinatie terwijl het model netjes citeerde, alleen zichzelf.
  const { accepted: welInGesprek } = rejectUngroundedFacts(
    rejected.map((r) => r.fact),
    transcript,
  );
  const uitAssistent = new Set(welInGesprek.map((f) => f.key));
  const uit: FactUpdate[] = [];

  const inhoudsloos: RejectedFact[] = [];

  for (const fact of verankerd) {
    // Een instemming draagt geen waarde. "Ja." komt van de cliënt en is dus verankerd,
    // maar bevestigt hooguit iets wat een ander heeft gezegd — en dat was hier juist het
    // model. Zonder deze regel is de verankering op de cliënt te omzeilen door het
    // antwoord te citeren in plaats van de vraag.
    if (fact.status !== 'unknown' && isContentlessAffirmation(fact.evidenceQuote)) {
      inhoudsloos.push({
        key: fact.key,
        reason: 'citaat is een instemming zonder inhoud; die draagt geen waarde',
      });
      continue;
    }

    const definitie = toegestaan.get(fact.key) ?? catalog.facts.find((f) => f.key === fact.key);
    if (!definitie) continue;

    // Bij "unknown" is er geen waarde om te valideren; de status ís het antwoord.
    if (fact.status !== 'unknown') {
      const geldig = definitie.validator.safeParse(fact.value);
      if (!geldig.success) continue;
    }

    // Het vangnet. Rekende de cliënt de waarde zelf uit, dan mag die nooit als
    // vastgesteld feit het dossier in — en al helemaal niet als de som niet klopt.
    //
    // Dit is geen extra voorzichtigheid maar het herstel van een concreet geval: live
    // landde 140.000 als `vso_severance_offered` met status `confirmed` en confidence
    // 0,85, met een keurig citaat eronder. De citaatverankering vond die zin immers
    // netjes terug. Een fout die er identiek uitziet als een goede, is de gevaarlijkste
    // soort in dit product.
    const som = findArithmeticClaim(fact.evidenceQuote);
    let status = fact.status;
    let confidence = fact.confidence;
    if (som && typeof fact.value === 'number' && Math.abs(fact.value - som.stated) < 0.01) {
      if (!som.correct) {
        // De uitkomst klopt niet. Vastleggen als "niet vastgesteld", mét het citaat, zodat
        // de advocaat ziet wat er gezegd is en dat er iets niet klopte.
        status = 'unknown';
        confidence = 0;
      } else if (status === 'confirmed') {
        // De som klopt, maar het blijft een afleiding van de cliënt en geen waarneming.
        status = 'inferred';
        confidence = Math.min(confidence, 0.6);
      }
    }

    uit.push({
      key: fact.key,
      value: status === 'unknown' ? null : fact.value,
      valueType: definitie.valueType,
      status,
      confidence,
      source: 'client_statement',
      sourceRef: fact.sourceRef ?? '',
      evidenceQuote: fact.evidenceQuote,
    });
  }
  return {
    updates: uit,
    rejected: [
      ...rejected.map((r) => ({
        key: r.fact.key,
        reason: uitAssistent.has(r.fact.key)
          ? 'citaat komt uit een assistent-beurt, niet van de cliënt'
          : r.reason,
      })),
      ...inhoudsloos,
    ],
  };
}

/** Alleen de beurten sinds de laatste extractie; de rest is al verwerkt. */
/**
 * De recente beurten, twee keer: als gesprek en als alleen-de-cliënt.
 *
 * Het volledige gesprek gaat naar het model, want zonder de vraag is een antwoord als
 * "ja" onbegrijpelijk. De **verankering** gaat alleen over wat de cliënt zei.
 *
 * Dat onderscheid repareert een concreet geval. De assistent vroeg "was dat 17 januari?"
 * — een datum die de cliënt nooit had genoemd — en de cliënt zei "ja". De extractie legde
 * 17 januari vast als `confirmed`, met als citaat de eigen vraag van de assistent. De
 * verankering keek naar het hele transcript en vond die zin daar netjes terug: het model
 * kon zichzelf als bron gebruiken.
 *
 * Een citaat uit een assistent-beurt bewijst alleen dat de assistent iets heeft gezegd.
 */
function nieuweBeurten(input: EngineInput): { transcript: string; clientOnly: string } {
  const recent = input.history.slice(-4);
  const regels = recent.map((t) => `${t.role === 'client' ? 'Cliënt' : 'Assistent'}: ${t.content}`);
  const clientRegels = recent.filter((t) => t.role === 'client').map((t) => t.content);

  if (input.lastClientUtterance) {
    regels.push(`Cliënt: ${input.lastClientUtterance}`);
    clientRegels.push(input.lastClientUtterance);
  }
  return { transcript: regels.join('\n'), clientOnly: clientRegels.join('\n') };
}

/**
 * Feiten die nog open staan én waarvan de voorwaarde is vervuld.
 *
 * De categoriefilter stond hier eerst niet, en dat had twee gevolgen. Het model kreeg bij
 * een loonconflict ook alle VSO-velden voorgeschoteld — een uitnodiging om iets te vinden
 * dat er niet is — en de lijst van ongeveer zevenveertig sleutels maakte de koude ronde
 * onnodig lang. Die duurde gemeten 8,5 seconde, terwijl een cliënt binnen twee seconden
 * antwoordt; dan werkt de planner met feiten van twee beurten terug en vraagt hij dingen
 * opnieuw.
 *
 * Alleen op **categorie** gefilterd en niet ook op de voorwaarde per feit — die gaat te
 * ver. `sick_since` hangt af van `currently_ill`, en een cliënt die zegt "ik ben ziek
 * gemeld sinds maart" noemt beide in één adem. Met de fijne filter erbij verdween de
 * datum uit de lijst en kwam hij pas een beurt later binnen. Bij een probleem dat juist
 * over vertraging gaat, is een extra beurt vertraging de verkeerde ruil.
 *
 * De categorie is de grove, stabiele filter: die hangt af van wat het gesprek ís, en niet
 * van wat er zojuist is gezegd.
 */
/**
 * Zet datums recht die uit een weekdagverwijzing komen.
 *
 * Het model rekent offsets goed uit ("twee maanden geleden") maar weekdagnamen niet:
 * gemeten gaf "afgelopen vrijdag" en "vorige week maandag" allebei dezelfde verkeerde
 * datum. Zie packages/domain/src/weekdag.ts voor de meting.
 *
 * Alleen datumvelden, alleen als er werkelijk een weekdag in het citaat staat, en alleen
 * als het vangnet iets ánders uitrekent. Staat er een expliciete datum bij ("vrijdag 21
 * augustus"), dan geeft `vindWeekdagVerwijzing` null terug en gebeurt er niets — een
 * vangnet dat gaat overschrijven wat al klopt, is zelf een risico.
 */
function corrigeerWeekdagen(
  updates: readonly FactUpdate[],
  anker: { iso: string; weekdagIndex: 1 | 2 | 3 | 4 | 5 | 6 | 7 },
  language: 'nl' | 'en',
  melden?: (c: { key: string; van: unknown; naar: string; uitspraak: string }) => void,
): readonly FactUpdate[] {
  return updates.map((update) => {
    if (update.valueType !== 'date' || update.status === 'unknown') return update;
    const verwijzing = vindWeekdagVerwijzing(update.evidenceQuote, language);
    if (!verwijzing) return update;

    const juist = resolveWeekdag(anker.iso, anker.weekdagIndex, verwijzing);
    if (String(update.value) === juist) return update;

    melden?.({
      key: update.key,
      van: update.value,
      naar: juist,
      uitspraak: verwijzing.gevonden,
    });
    return { ...update, value: juist };
  });
}

function gezochteFeiten(catalog: FactCatalog, facts: CaseFactMap): readonly FactDefinition[] {
  /*
   * De categorie én het feit zelf, en dat tweede stond hier niet.
   *
   * `planner.ts` en `completeness.ts` toetsten allebei ook `fact.relevantWhen`; deze functie
   * alleen de categorie. De extractie zocht daardoor naar feiten uit takken die de planner
   * nooit vraagt en die de score nooit meetelt — en die dan wél in `case_facts` belanden.
   * Zie relevantie.ts.
   */
  const categorieen = relevanteCategorieen(catalog, facts);
  return catalog.facts.filter((f) => {
    if (!isRelevant(f, facts, categorieen)) return false;
    const bestaand = facts[f.key];
    if (!bestaand) return true;
    /*
     * `unknown` betekent niet "we hebben het al", maar "het is niet vastgesteld".
     *
     * Hier stond `return !bestaand || bestaand.status === 'contradicted'`, en daarmee viel
     * een feit met status `unknown` uit de zoeklijst. Gevolg, gemeten: de assistent vraagt
     * "sinds wanneer bent u ziek?", de cliënt zegt "dat weet ik niet precies", `sick_since`
     * wordt vastgelegd als unknown — en als de cliënt het zich twee beurten later herinnert
     * en "begin juli" zegt, kijkt de extractie er niet meer naar. Het antwoord valt stil op
     * de grond, en niemand ziet dat het er was.
     *
     * `confirmed` en `inferred` zijn vastgesteld; `unknown` en `contradicted` niet.
     */
    /*
     * Hier stond `contradicted || unknown`, en dat sprak `isBeantwoord` tegen.
     *
     * De planner en de score rekenden `unknown` als beantwoord — met een uitgeschreven reden:
     * "dat weet ik niet" is een antwoord, en er twee keer naar terugvragen maakt van een
     * gesprek een formulier. Deze regel deed het omgekeerde, zonder toelichting. Het gevolg
     * was dat de score "klaar" zei terwijl de assistent bleef doorvragen.
     *
     * Nu één predicaat. `contradicted` blijft wél terugkomen: daarover sprak de cliënt
     * zichzelf tegen, en dat is iets anders dan niet weten.
     */
    return !isBeantwoord(facts, f.key);
  });
}

function bekendeFeiten(
  catalog: FactCatalog,
  facts: CaseFactMap,
  language: 'nl' | 'en',
): readonly { label: string; value: string }[] {
  const uit: { label: string; value: string }[] = [];
  for (const definitie of catalog.facts) {
    const fact = facts[definitie.key];
    if (!fact || fact.status === 'contradicted') continue;
    if (fact.status === 'unknown') continue;
    uit.push({ label: definitie.label[language], value: String(fact.value ?? '') });
  }
  return uit;
}
