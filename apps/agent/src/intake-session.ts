import {
  EMPLOYMENT_RULES,
  EMPLOYMENT_TEMPLATE,
  type CaseFact,
  type Language,
  type OrgConfig,
  type Turn,
} from '@intake/domain';
import {
  createIntakeEngine,
  type ColdPathModel,
  type HotPathModel,
  type ObservationResult,
  type RenderedPrompt,
} from '@intake/engine';
import type { LLMProvider } from '@intake/provider-llm';
import type { ResponseSource } from './turn-loop';

/**
 * De echte engine in de beurtcyclus, in plaats van de echo.
 *
 * De echo herhaalde wat de cliënt zei. Dat was opzet: Fase 1 moest meten of de keten
 * werkt zonder dat een tegenvallend getal aan de generatie kon liggen. Die vraag is
 * beantwoord, dus hier komt het model in de lus.
 *
 * ## Wat deze module wél en niet doet
 *
 * Hij houdt de gespreksstaat vast — feiten, geschiedenis — en vertaalt tussen de
 * `ResponseSource` die de turn-loop verwacht en de `IntakeConversationEngine`. Meer niet.
 * De intelligentie zit in `@intake/engine` en blijft daar: zou de planner of de
 * promptkeuze hierheen lekken, dan werkt de chat-fallback niet langer identiek aan de
 * videomodus.
 *
 * ## Twee sporen, één staat
 *
 * `respond()` draait op het spraakpad en gebruikt de feiten van beurt N−1. `observe()`
 * draait erna, buiten de klok, en werkt die feiten bij. Die vertraging van één beurt is
 * bewust: het hot-path model ziet het ruwe transcript, dus het gesprek voelt niet
 * vertraagd — alleen de planner loopt een beurt achter, en die stelt de vraag ná het
 * antwoord.
 */

export interface IntakeSessionOptions {
  readonly llm: LLMProvider;
  readonly organization: OrgConfig;
  readonly language?: Language;
  readonly hotModel: string;
  readonly coldModel: string;
  /** Klok, geïnjecteerd zodat termijnregels in tests reproduceerbaar zijn. */
  readonly now?: () => Date;
  /** Elke gerenderde prompt, voor `llm_calls`. */
  readonly onPrompt?: (prompt: RenderedPrompt) => void;
  /** Na elke koude ronde: feiten, regels, score, en wat er geweigerd is. */
  readonly onObservation?: (result: ObservationResult) => void;
  /** Doorgegeven aan de engine; nul zet de narratieve fase uit. Zie diag:gespreksvorm. */
  readonly narrativeTurns?: number;
}

export class IntakeSession {
  private readonly engine;
  private readonly facts: Record<string, CaseFact> = {};
  private readonly history: Turn[] = [];
  private laatstePrompt: RenderedPrompt | null = null;

  /**
   * Wat de citaatverankering deze sessie heeft geweigerd.
   *
   * Dit veld bestaat omdat een weigering die nergens landt, niet te onderscheiden is
   * van een controle die niets doet. Het gaat naar de HUD én naar `llm_calls`.
   */
  private readonly geweigerd: { key: string; reason: string }[] = [];

  constructor(private readonly options: IntakeSessionOptions) {
    const hot: HotPathModel = {
      stream: (req) => {
        const berichten = [
          ...req.history.map((t) => ({
            role: t.role === 'client' ? ('user' as const) : ('assistant' as const),
            content: t.content,
          })),
          ...(req.lastClientUtterance
            ? [{ role: 'user' as const, content: req.lastClientUtterance }]
            : []),
        ];

        // De openingsbeurt heeft geen geschiedenis en geen uitspraak van de cliënt, en
        // een chat-API weigert een lege berichtenlijst. Dit is de aanleiding, expliciet
        // benoemd: zonder dit crasht precies de beurt waarop de cliënt zijn eerste
        // indruk vormt, en met een HTTP 400 die niets over de oorzaak zegt.
        if (berichten.length === 0) {
          berichten.push({
            role: 'user' as const,
            content: '[De cliënt heeft de intake geopend en wacht op je eerste woorden.]',
          });
        }

        return options.llm.streamText({
          system: req.system,
          messages: berichten,
          model: options.hotModel,
          // Kort. Een beurt van vijf zinnen is niet alleen traag om te genereren, hij is
          // ook onprettig om naar te luisteren en onmogelijk om te onderbreken zonder
          // dat er iets zinnigs half is uitgesproken.
          maxTokens: 220,
        });
      },
    };

    const cold: ColdPathModel = {
      complete: async (req) => {
        const input = req.repairOf
          ? `${req.user}\n\nJe vorige antwoord was ongeldig:\n${req.repairOf.previous.slice(0, 2000)}\n\nFout: ${req.repairOf.error}`
          : req.user;
        // Geen generateStructured: de engine heeft zijn eigen validatie en
        // reparatielus, en twee reparatielussen boven elkaar maken niet duidelijker
        // wie welke fout heeft hersteld.
        const stukken: string[] = [];
        for await (const stuk of options.llm.streamText({
          system: req.system,
          messages: [{ role: 'user', content: input }],
          model: options.coldModel,
          maxTokens: 2048,
        })) {
          stukken.push(stuk);
        }
        return stukken.join('');
      },
    };

    this.engine = createIntakeEngine({
      hot,
      cold,
      ...(options.narrativeTurns !== undefined ? { narrativeTurns: options.narrativeTurns } : {}),
      onPrompt: (p) => {
        this.laatstePrompt = p;
        options.onPrompt?.(p);
      },
    });
  }

  /** De bron die de turn-loop aanroept. Levert platte tekst, per fragment. */
  responseSource(): ResponseSource {
    return (input, signal) => {
      const self = this;
      return (async function* () {
        const beslissing = await self.engine.respond(self.invoer(input));
        for await (const stuk of beslissing.speak) {
          if (signal.aborted) return;
          yield stuk;
        }
      })();
    };
  }

  /**
   * De koude ronde. Draait ná de beurt en mag falen zonder het gesprek te raken.
   *
   * De aanroeper hoort dit niet te awaiten op het spraakpad; doet hij dat wel, dan is de
   * scheiding tussen hot en cold path alleen nog een naam.
   */
  /**
   * De beurt in de geschiedenis zetten. Synchroon, en los van de koude ronde.
   *
   * Twee dingen die niet samenvallen: de geschiedenis moet meteen kloppen voor de
   * volgende beurt, terwijl de extractie een modelaanroep is die buiten de klok hoort.
   * Zaten ze in één methode, dan zou de turn-loop moeten wachten op een extractie om
   * zijn eigen geschiedenis bij te werken — en dan is de scheiding tussen hot en cold
   * path alleen nog een naam.
   */
  recordTurn(clientUtterance: string, assistantContent: string): void {
    // Alleen vastleggen wat er werkelijk is gezegd. Bij de openingsbeurt zegt de cliënt
    // niets, en een leeg cliëntbericht in de geschiedenis laat elke volgende beurt op
    // een HTTP 400 stuklopen — precies het geval dat live naar boven kwam.
    if (clientUtterance.trim()) {
      this.history.push(beurt('client', clientUtterance, this.history.length));
    }
    if (assistantContent.trim()) {
      this.history.push(beurt('assistant', assistantContent, this.history.length));
    }
  }

  async observe(): Promise<ObservationResult> {
    const resultaat = await this.engine.observe(this.invoer({ utterance: '' }));

    for (const update of resultaat.factUpdates) {
      this.facts[update.key] = {
        key: update.key,
        value: update.value,
        valueType: update.valueType,
        status: update.status,
        confidence: update.confidence,
        source: update.source,
        sourceRef: update.sourceRef || null,
        llmCallId: null,
        updatedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
    }
    if (resultaat.rejectedFacts) this.geweigerd.push(...resultaat.rejectedFacts);

    this.options.onObservation?.(resultaat);
    return resultaat;
  }

  /** Alles wat de citaatverankering deze sessie heeft geweigerd. */
  rejectedFacts(): readonly { key: string; reason: string }[] {
    return this.geweigerd;
  }

  /** De laatst gerenderde prompt; sleutel en versie gaan mee naar `llm_calls`. */
  lastPrompt(): RenderedPrompt | null {
    return this.laatstePrompt;
  }

  knownFacts(): Readonly<Record<string, CaseFact>> {
    return this.facts;
  }

  private invoer(input: { utterance: string; interruptedPrefix?: string }) {
    return {
      organization: this.options.organization,
      practiceArea: 'employment' as const,
      template: EMPLOYMENT_TEMPLATE,
      rules: EMPLOYMENT_RULES,
      facts: this.facts,
      history: this.history,
      documents: [],
      pendingLawyerRequests: [],
      language: this.options.language ?? ('nl' as Language),
      mode: 'realtime' as const,
      now: this.options.now?.() ?? new Date(),
      ...(input.utterance ? { lastClientUtterance: input.utterance } : {}),
      ...(input.interruptedPrefix ? { interruptedPrefix: input.interruptedPrefix } : {}),
    };
  }
}

function beurt(role: 'client' | 'assistant', content: string, index: number): Turn {
  return {
    id: `turn-${index}`,
    role,
    content,
    plannedQuestionKeys: [],
    createdAt: new Date().toISOString(),
  };
}
