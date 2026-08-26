import {
  hervattingsZin,
  kiesErkenning,
  wanhoopReactie,
  type WanhoopReactie,
  type ErkenningKeuze,
  type ErkenningStand,
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
  type LadingOordeel,
  type HotPathModel,
  type ObservationResult,
  type RenderedPrompt,
} from '@intake/engine';
import { dagdeelGroet } from '@intake/prompts';
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
  /**
   * De naam die de cliënt op het toestemmingsscherm heeft ingevuld.
   *
   * Geen feit uit het gesprek: hij staat op de intake vóór de eerste beurt, en de opening
   * is precies de beurt waarin hij gebruikt wordt. Ontbreekt hij, dan groet de assistent
   * zonder naam en verzint er geen.
   */
  readonly clientName?: string | null;
  readonly language?: Language;
  /** Feiten uit eerdere beurten van deze intake, uit `agent_context`. */
  readonly initialFacts?: Readonly<Record<string, CaseFact>>;
  /** Het transcript tot nu toe, uit `agent_context`. */
  readonly initialHistory?: readonly Turn[];
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
  /**
   * Elke erkenningsbeslissing, ook als er niets is gezegd.
   *
   * Inclusief de reden om te zwijgen. Een laag die alleen meldt wanneer hij iets doet, is
   * niet te onderscheiden van een laag die stukstaat.
   */
  readonly onErkenning?: (keuze: ErkenningKeuze, oordeel: LadingOordeel) => void;
  /** Het ladingoordeel liep stuk. Nooit stil. */
  readonly onLadingFout?: (fout: unknown) => void;
  /** Een tweede verbinding met een lopende intake. Zie hervatting.ts. */
  readonly onHervatting?: (info: { clientName: string | null; turnCount: number }) => void;
  /** Wat er bekend was toen de openingszin werd gebouwd. Zie de engine. */
  readonly onOpening?: (info: {
    clientName: string | null;
    organisationName: string;
    turnCount: number;
  }) => void;
  /**
   * Elke stap van het wanhoopspad: gedetecteerd, vastgelegd, of niet vastgelegd.
   *
   * Drie meldingen en niet één, want "de detectie ging af" en "het staat in het dossier"
   * zijn verschillende beweringen en kunnen los van elkaar misgaan.
   */
  readonly onWanhoop?: (reactie: WanhoopReactie, stap: string) => void;
  /**
   * De agent-RPC, voor de risicovlag bij wanhoop.
   *
   * Optioneel: zonder verbinding met het dossier draait het gesprek door, maar dan meldt
   * `onWanhoop` met zoveel woorden dat er niets is vastgelegd.
   */
  readonly rpc?: {
    setRiskFlag(args: {
      ruleKey: string;
      level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      label: string;
      detectedBy: 'rule' | 'rule+ai';
      sourceRef: string | null;
    }): Promise<unknown>;
  };
  /**
   * De erkenningslaag uitzetten.
   *
   * Bestaat zodat een diagnose de lus kan draaien zonder de tweede modelaanroep, en zodat
   * een kantoor die er niet om vraagt hem niet krijgt. Standaard aan.
   */
  readonly erkenningAan?: boolean;
}

export class IntakeSession {
  private readonly engine;
  private readonly facts: Record<string, CaseFact>;
  private readonly history: Turn[];
  private laatstePrompt: RenderedPrompt | null = null;
  private erkenningStand: ErkenningStand = { gebruikt: [], laatsteBeurt: null };
  private laatsteErkenning: string | null = null;
  private laatsteOordeel: LadingOordeel | null = null;

  /**
   * Wat de citaatverankering deze sessie heeft geweigerd.
   *
   * Dit veld bestaat omdat een weigering die nergens landt, niet te onderscheiden is
   * van een controle die niets doet. Het gaat naar de HUD én naar `llm_calls`.
   */
  private readonly geweigerd: { key: string; reason: string }[] = [];

  constructor(private readonly options: IntakeSessionOptions) {
    /*
     * Beginnen bij wat er al vaststaat, niet bij nul.
     *
     * Een tweede gesprek over dezelfde intake — de cliënt kwam terug, of de verbinding
     * viel weg — hoort niet opnieuw te vragen wat er al in het dossier staat. Zonder deze
     * twee regels begon elke sessie blanco en stelde de planner vragen die allang
     * beantwoord waren.
     */
    this.facts = { ...(options.initialFacts ?? {}) };
    this.history = [...(options.initialHistory ?? [])];

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

    /*
     * Het ladingmodel: dezelfde leverancier, hetzelfde snelle model, maar één korte
     * aanroep zonder streaming. Er valt niets uit te spreken -- de uitvoer is een
     * categorie, en de zin die erop volgt komt uit de vaste lijst in @intake/domain.
     *
     * Kort begrensd op tokens: het antwoord is drie velden. Een model dat hier gaat
     * uitweiden, levert alleen maar iets op wat niet door het schema komt.
     */
    const classify = {
      complete: async (req: { system: string; user: string }) => {
        const stukken: string[] = [];
        for await (const stuk of options.llm.streamText({
          system: req.system,
          messages: [{ role: 'user', content: req.user }],
          model: options.hotModel,
          maxTokens: 120,
        })) {
          stukken.push(stuk);
        }
        return stukken.join('');
      },
    };

    this.engine = createIntakeEngine({
      hot,
      cold,
      ...(options.erkenningAan === false ? {} : { classify }),
      onLadingFout: (fout) => options.onLadingFout?.(fout),
      onOpening: (info) => options.onOpening?.(info),
      onHervatting: (info) => options.onHervatting?.(info),
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

        /*
         * De erkenning gaat vóór het antwoord, maar houdt het nooit op.
         *
         * Het ladingoordeel draait náást de generatie. Hier wordt geracet: is het oordeel
         * er vóór het eerste fragment van het model, dan mag de erkenning erlangs. Is het
         * er niet, dan zwijgt de assistent en begint het antwoord gewoon.
         *
         * Er wordt dus nooit gewacht. Een gemiste erkenning is een gesprek dat iets
         * zakelijker verloopt; een vertraagd antwoord is een gesprek dat hapert, en dat is
         * erger.
         */
        /*
         * De hervattingszin gaat vóór alles, en wacht op niets.
         *
         * Hij hangt niet aan een modeloordeel — de lus weet zelf dat dit een tweede
         * verbinding is — dus er valt hier niets te racen. Vaste tekst, met de naam erin en
         * verder niets: geen samenvatting en geen verwijzing naar wat er eerder is verteld.
         * Zie hervatting.ts voor waarom dat laatste een belofte zou zijn die het systeem
         * niet kan waarmaken.
         */
        if (beslissing.isResuming && !signal.aborted) {
          const zin = hervattingsZin(
            {
              greeting: dagdeelGroet(
                self.options.now?.() ?? new Date(),
                self.options.language ?? 'nl',
                self.options.organization.timeZone,
              ),
              clientName: self.options.clientName ?? null,
            },
            self.options.language ?? 'nl',
          );
          yield `${zin} `;
        }

        const stroom = beslissing.speak[Symbol.asyncIterator]();
        const eersteStuk = stroom.next();

        if (beslissing.lading) {
          const winnaar = await Promise.race([
            beslissing.lading.then((oordeel) => ({ soort: 'lading' as const, oordeel })),
            eersteStuk.then(() => ({ soort: 'model' as const, oordeel: null })),
          ]);

          if (winnaar.soort === 'lading' && winnaar.oordeel) {
            self.laatsteOordeel = winnaar.oordeel;

            /*
             * Het wanhoopspad gaat vóór alles, en sluit de beurt af.
             *
             * De vraag van de planner vervalt — niet uitgesteld tot verderop in dezelfde
             * beurt, maar vervallen. Een erkenning met een vraag erachter is geen
             * erkenning, en doorvragen op wanhoop door een systeem dat niet kan helpen is
             * schadelijk.
             *
             * De generatie van het model wordt hier bewust weggegooid. Die is al onderweg
             * en kost dus toch wat hij kost; hem alsnog uitspreken zou betekenen dat er een
             * intakevraag achter de verwijzing aan komt.
             */
            const reactie = wanhoopReactie(winnaar.oordeel.wanhoop, self.options.language ?? 'nl');
            if (reactie) {
              await self.meldWanhoop(reactie);
              if (!signal.aborted) yield reactie.tekst;
              return;
            }

            const keuze = kiesErkenning(
              winnaar.oordeel.lading,
              self.history.length,
              self.erkenningStand,
              self.options.language ?? 'nl',
            );
            self.options.onErkenning?.(keuze, winnaar.oordeel);
            if (keuze.zin && !signal.aborted) {
              self.erkenningStand = {
                gebruikt: [...self.erkenningStand.gebruikt, keuze.zin],
                laatsteBeurt: self.history.length,
              };
              self.laatsteErkenning = keuze.zin;
              // Met een spatie erachter: de zinsflusher knipt op het leesteken, dus dit
              // wordt een eigen zin en gaat als eerste naar de TTS.
              yield `${keuze.zin} `;
            }
          } else {
            // Het model was eerder. Het oordeel komt alsnog binnen en telt nog steeds voor
            // het wanhoopspad en voor de urgentie -- alleen niet meer voor een erkenning.
            void beslissing.lading.then((oordeel) => {
              if (oordeel) self.laatsteOordeel = oordeel;
            });
          }
        }

        const eerste = await eersteStuk;
        if (signal.aborted) return;
        if (!eerste.done) yield eerste.value;

        for (;;) {
          const volgende = await stroom.next();
          if (volgende.done || signal.aborted) return;
          yield volgende.value;
        }
      })();
    };
  }

  /**
   * De vlag in het dossier zetten, en luid zijn als dat niet lukt.
   *
   * Dit pad mag nooit stil falen. Gaat de detectie af en gebeurt er niets, dan hoort dat
   * terug te komen in het log én zichtbaar te zijn — anders is "het systeem heeft het
   * gezien" een bewering die niemand kan nakijken.
   *
   * Zonder RPC — het ontwikkelharnas zonder sessietoken — is er geen dossier om in te
   * schrijven. Ook dat wordt gemeld, en met zoveel woorden dat niemand het voor een
   * geslaagde vastlegging aanziet.
   */
  private async meldWanhoop(reactie: WanhoopReactie): Promise<void> {
    this.options.onWanhoop?.(reactie, 'gedetecteerd');

    if (!this.options.rpc) {
      this.options.onWanhoop?.(reactie, 'NIET VASTGELEGD: geen verbinding met het dossier');
      return;
    }
    try {
      await this.options.rpc.setRiskFlag({
        ruleKey: reactie.regelKey,
        level: reactie.niveau,
        label: reactie.label,
        // 'rule+ai': het oordeel komt van een model, de reactie en de drempel uit code.
        detectedBy: 'rule+ai',
        sourceRef: null,
      });
      this.options.onWanhoop?.(reactie, 'vastgelegd in het dossier');
    } catch (fout) {
      this.options.onWanhoop?.(
        reactie,
        `NIET VASTGELEGD: ${fout instanceof Error ? fout.message : String(fout)}`,
      );
    }
  }

  /** De erkenning die deze beurt is uitgesproken, of `null`. */
  lastAcknowledgement(): string | null {
    const zin = this.laatsteErkenning;
    this.laatsteErkenning = null;
    return zin;
  }

  /** Het laatste ladingoordeel; voedt straks het wanhoopspad en de urgentie. */
  lastCharge(): LadingOordeel | null {
    return this.laatsteOordeel;
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
      clientName: this.options.clientName ?? null,
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
