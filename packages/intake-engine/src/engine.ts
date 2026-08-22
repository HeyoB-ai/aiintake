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
} from '@intake/domain';
import { PROMPTS, practiceAreaLabel, render, type RenderedPrompt } from '@intake/prompts';

/**
 * Doorgegeven, zodat een aanroeper de sleutel en versie voor `llm_calls` kan vastleggen
 * zonder zelf aan `@intake/prompts` te hoeven hangen. De worker hoort niet te weten dat
 * promptsjablonen bestaan; hij hoort alleen te weten wat hij moet loggen.
 */
export type { RenderedPrompt };
import { scoreCompleteness } from './completeness';
import { evaluate } from './conditions';
import { planQuestions } from './planner';
import { evaluateRules } from './rules';
import type {
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
      const isClosing = plan.shouldClose && !isOpening;
      const narrativePhase = !isClosing && turnCount <= narrativeTurns * 2;

      // Pacing. De overbruggingszin is een middel tegen stilte, geen stijlkenmerk:
      // vaker dan eens per drie beurten en het wordt een tic die opvalt.
      const allowFiller =
        !isOpening && !isClosing && turnCount > 0 && turnCount % FILLER_INTERVAL === 0;
      // In de narratieve fase iets meer ruimte: een uitnodiging om te vertellen kost
      // een zin meer dan een gesloten vraag.
      const maxSentences = isClosing ? 2 : isOpening ? 3 : narrativePhase ? 3 : 2;

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
          isClosing,
          narrativePhase,
          ...(somFout && !somFout.correct
            ? { arithmeticWarning: describeClaim(somFout, input.language) }
            : {}),
        },
        input.language,
      );
      deps.onPrompt?.(prompt);

      const speak = deps.hot.stream({
        system: prompt.body,
        // 'system'-beurten zijn interne notities en horen niet in de gespreksgeschiedenis
        // die het model als dialoog leest.
        history: input.history
          .filter((t): t is typeof t & { role: 'client' | 'assistant' } => t.role !== 'system')
          .map((t) => ({ role: t.role, content: t.content })),
        ...(input.lastClientUtterance ? { lastClientUtterance: input.lastClientUtterance } : {}),
      });

      return {
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
          todayIso: input.now.toISOString().slice(0, 10),
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

      return {
        ...beoordeel(input, updates, catalog),
        factUpdates: updates,
        rejectedFacts: rejected,
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
function gezochteFeiten(catalog: FactCatalog, facts: CaseFactMap): readonly FactDefinition[] {
  const relevanteCategorieen = new Set(
    catalog.categories.filter((c) => evaluate(c.relevantWhen, facts)).map((c) => c.key),
  );
  return catalog.facts.filter((f) => {
    if (!relevanteCategorieen.has(f.category)) return false;
    const bestaand = facts[f.key];
    return !bestaand || bestaand.status === 'contradicted';
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
