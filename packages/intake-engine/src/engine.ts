import {
  EMPLOYMENT_CATALOG,
  FactExtractionResultSchema,
  rejectUngroundedFacts,
  type CaseFactMap,
  type FactCatalog,
  type FactDefinition,
} from '@intake/domain';
import { PROMPTS, practiceAreaLabel, render, type RenderedPrompt } from '@intake/prompts';
import { scoreCompleteness } from './completeness';
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
}

/** Hoeveel beurten er minimaal tussen twee overbruggingszinnen zitten. */
const FILLER_INTERVAL = 3;

export function createIntakeEngine(deps: EngineDeps): IntakeConversationEngine {
  const catalog = deps.catalog ?? EMPLOYMENT_CATALOG;

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

      const isOpening = turnCount === 0 && !input.lastClientUtterance;
      const isClosing = plan.shouldClose && !isOpening;

      // Pacing. De overbruggingszin is een middel tegen stilte, geen stijlkenmerk:
      // vaker dan eens per drie beurten en het wordt een tic die opvalt.
      const allowFiller =
        !isOpening && !isClosing && turnCount > 0 && turnCount % FILLER_INTERVAL === 0;
      const maxSentences = isClosing ? 2 : isOpening ? 3 : 2;

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
      const completeness = scoreCompleteness(input.facts, input.template, catalog);
      const riskFlags = evaluateRules(input.rules, input.facts, input.now, input.language).map(
        (r) => ({ ruleKey: r.ruleKey, level: r.level, label: r.label }),
      );

      // Zonder nieuwe spraak valt er niets te extraheren, en dan is een modelaanroep
      // alleen kosten. De score en de regels rekenen we wél opnieuw: die hangen ook van
      // de klok af, en een deadline die vannacht dichterbij kwam moet vanochtend zichtbaar
      // zijn zonder dat de cliënt eerst iets hoeft te zeggen.
      const transcript = nieuweBeurten(input);
      if (!transcript.trim()) {
        return {
          factUpdates: [],
          riskFlags,
          completeness: completeness.score,
          missingRequiredKeys: completeness.missingRequiredKeys,
        };
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

      const { updates, rejected } = await extraheer(
        deps.cold,
        prompt.body,
        transcript,
        catalog,
        gezocht,
      );

      return {
        factUpdates: updates,
        riskFlags,
        completeness: completeness.score,
        missingRequiredKeys: completeness.missingRequiredKeys,
        rejectedFacts: rejected,
      };
    },
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
  catalog: FactCatalog,
  gezocht: readonly FactDefinition[],
): Promise<{ updates: readonly FactUpdate[]; rejected: readonly RejectedFact[] }> {
  const user = 'Geef de feiten die je in het transcript vindt.';
  let ruw = await cold.complete({ system, user });

  for (let poging = 0; poging < 2; poging += 1) {
    const geparsed = parseJson(ruw);
    if (geparsed.ok) {
      const gevalideerd = FactExtractionResultSchema.safeParse(geparsed.value);
      if (gevalideerd.success) {
        return naarFactUpdates(gevalideerd.data, transcript, catalog, gezocht);
      }
      if (poging === 1) return LEEG;
      ruw = await cold.complete({
        system,
        user,
        repairOf: { previous: ruw, error: gevalideerd.error.message.slice(0, 800) },
      });
      continue;
    }
    if (poging === 1) return LEEG;
    ruw = await cold.complete({
      system,
      user,
      repairOf: { previous: ruw, error: geparsed.error },
    });
  }
  return LEEG;
}

const LEEG = { updates: [] as readonly FactUpdate[], rejected: [] as readonly RejectedFact[] };

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
  resultaat: { facts: readonly unknown[] },
  transcript: string,
  catalog: FactCatalog,
  gezocht: readonly FactDefinition[],
): { updates: readonly FactUpdate[]; rejected: readonly RejectedFact[] } {
  const { accepted: verankerd, rejected } = rejectUngroundedFacts(
    resultaat.facts as Parameters<typeof rejectUngroundedFacts>[0],
    transcript,
  );
  const toegestaan = new Map(gezocht.map((f) => [f.key, f]));
  const uit: FactUpdate[] = [];

  for (const fact of verankerd) {
    const definitie = toegestaan.get(fact.key) ?? catalog.facts.find((f) => f.key === fact.key);
    if (!definitie) continue;

    // Bij "unknown" is er geen waarde om te valideren; de status ís het antwoord.
    if (fact.status !== 'unknown') {
      const geldig = definitie.validator.safeParse(fact.value);
      if (!geldig.success) continue;
    }

    uit.push({
      key: fact.key,
      value: fact.status === 'unknown' ? null : fact.value,
      valueType: definitie.valueType,
      status: fact.status,
      confidence: fact.confidence,
      source: 'client_statement',
      sourceRef: fact.sourceRef ?? '',
      evidenceQuote: fact.evidenceQuote,
    });
  }
  return {
    updates: uit,
    rejected: rejected.map((r) => ({ key: r.fact.key, reason: r.reason })),
  };
}

/** Alleen de beurten sinds de laatste extractie; de rest is al verwerkt. */
function nieuweBeurten(input: EngineInput): string {
  const recent = input.history.slice(-4);
  const regels = recent.map((t) => `${t.role === 'client' ? 'Cliënt' : 'Assistent'}: ${t.content}`);
  if (input.lastClientUtterance) regels.push(`Cliënt: ${input.lastClientUtterance}`);
  return regels.join('\n');
}

/** Feiten die nog open staan en waarvan de voorwaarde is vervuld. */
function gezochteFeiten(catalog: FactCatalog, facts: CaseFactMap): readonly FactDefinition[] {
  return catalog.facts.filter((f) => {
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
