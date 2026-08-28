import {
  hervattingsZin,
  kiesErkenning,
  wanhoopReactie,
  ERKENNING_MARKERING,
  NIET_VERSTAAN,
  type WanhoopReactie,
  type ErkenningKeuze,
  type ErkenningStand,
  EMPLOYMENT_RULES,
  EMPLOYMENT_TEMPLATE,
  onderwerpVan,
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
  /** Feitsleutels uit het toestemmingsscherm; de planner vraagt er niet naar. */
  readonly knownFromForm?: readonly string[];
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
   * De agent-RPC: transcript, feiten, signalen en voortgang.
   *
   * Optioneel: zonder verbinding met het dossier draait het gesprek door, maar dan meldt
   * `onWanhoop` en `onVastlegging` met zoveel woorden dat er niets is vastgelegd.
   */
  readonly rpc?: {
    setRiskFlag(args: {
      ruleKey: string;
      level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      label: string;
      detectedBy: 'rule' | 'rule+ai';
      sourceRef: string | null;
    }): Promise<unknown>;
    appendMessage(args: {
      turnIndex: number;
      role: 'assistant' | 'client' | 'system';
      content: string;
      intendedContent?: string | null;
      interruptedAtChar?: number | null;
      spokenMs?: number | null;
      plannedQuestionKeys?: string[];
      clientUtteranceWasCut?: boolean;
    }): Promise<unknown>;
    upsertFact(args: {
      key: string;
      value: unknown;
      valueType: 'string' | 'number' | 'date' | 'boolean' | 'enum';
      status: 'confirmed' | 'inferred' | 'unknown' | 'contradicted';
      confidence: number;
      source: 'client_statement' | 'document' | 'lawyer_input';
      sourceRef: string | null;
      evidenceQuote?: string | null;
    }): Promise<unknown>;
    /*
     * `status` staat hier bewust niet in, ook al kent de RPC hem.
     *
     * De agent mag nooit ACCEPTED/REJECTED/REFERRED zetten (§6) en de RPC weigert dat ook — maar
     * deze poort is smaller dan wat de RPC toelaat, zodat de vraag hier niet eens gesteld kan
     * worden. Wat een laag niet kan aanroepen, kan hij niet per ongeluk doen.
     */
    updateProgress(args: {
      completeness?: number | null;
      subject?: string | null;
    }): Promise<unknown>;
  };
  /**
   * Wat er van de koude weg in het dossier is beland, of waarom niet.
   *
   * Dezelfde afspraak als bij `onBericht`: nooit stil. Een feit dat niet landt, is van buiten
   * niet te onderscheiden van een feit dat de cliënt nooit heeft verteld — en dat is precies
   * het verschil waar een advocaat op afgaat.
   */
  readonly onVastlegging?: (info: {
    soort: 'feit' | 'signaal' | 'voortgang';
    sleutel: string;
    stap: 'vastgelegd' | string;
  }) => void;
  /**
   * Elk bericht dat is weggeschreven, of de reden waarom niet.
   *
   * Nooit stil: een transcript dat niet landt, is van buiten niet te onderscheiden van een
   * gesprek dat niet heeft plaatsgevonden.
   */
  readonly onBericht?: (info: {
    turnIndex: number;
    role: 'assistant' | 'client' | 'system';
    tekens: number;
    stap: 'weggeschreven' | string;
  }) => void;
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
  private laatsteAfsluiting: 'complete' | 'max_turns' | null = null;
  /** De erkenning van de lopende beurt; wordt bij het wegschrijven afgesplitst. */
  private erkenningVanBeurt: string | null = null;
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
        // Vastleggen vóórdat er iets wordt uitgesproken: de aanroeper leest dit ná de beurt.
        self.laatsteAfsluiting =
          beslissing.intent === 'close' ? (beslissing.closeReason ?? 'complete') : null;

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
              self.erkenningVanBeurt = keuze.zin;
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

  /**
   * Heeft de engine deze beurt het gesprek afgesloten, en waarom?
   *
   * `null` zolang er niets is afgesloten. `intent: 'close'` werd tot nu toe door niemand
   * gelezen: de lus sprak de afsluitzin uit en luisterde daarna gewoon verder. Wat een cliënt
   * daarvan merkt is dat het gesprek stilvalt en de verbinding op een willekeurig moment weggaat
   * — het laatste wat hij meemaakt.
   */
  afsluiting(): 'complete' | 'max_turns' | null {
    return this.laatsteAfsluiting;
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

  /**
   * De beurt naar `messages`, buiten de klok.
   *
   * ## Waarom hier en niet in live/server.ts
   *
   * Dit is de aanroep die je bij een latere overstap naar een ander transport wilt
   * behouden. In de transportlaag zou hij mee verdwijnen; hier verhuist hij mee zonder
   * aanpassing. Zie het beslisdocument over weg A.
   *
   * ## Waarom de erkenning een eigen bericht wordt
   *
   * De erkenning is vóór het antwoord de spraakstroom in gezet, dus hij zit ín
   * `assistantContent`. Zou hij daar blijven, dan is er geen enkele manier om hem later
   * terug te vinden — en een erkenning mag nooit als grondslag voor een feit tellen.
   *
   * Assistent-beurten zijn al uitgesloten van extractie; dat is het eerste slot. Dit is het
   * tweede: een eigen bericht met `ERKENNING_MARKERING` ervoor, leesbaar voor een mens die
   * het transcript nakijkt. Twee sloten op één deur, want het eerste werkt alleen zolang
   * niemand ooit besluit assistent-tekst wél mee te wegen.
   *
   * `interruptedAtChar` wordt meeverschoven met de lengte van het afgesplitste stuk. Dat
   * getal is een index in wat er is uitgesproken, en zou hij blijven staan, dan wijst hij
   * na het afsplitsen naar het verkeerde teken — precies de soort stille fout die het
   * transcript onbetrouwbaar maakt.
   */
  async persistTurn(turn: {
    turnIndex: number;
    clientUtterance: string;
    assistantContent: string;
    intendedContent: string;
    interruptedAtChar: number | null;
    spokenMs: number | null;
    clientUtteranceWasCut: boolean;
    plannedQuestionKeys?: readonly string[];
  }): Promise<void> {
    const rpc = this.options.rpc;
    if (!rpc) return;

    const schrijf = async (
      role: 'assistant' | 'client',
      content: string,
      extra: Record<string, unknown>,
    ): Promise<void> => {
      if (!content.trim()) return;
      try {
        await rpc.appendMessage({ turnIndex: turn.turnIndex, role, content, ...extra });
        this.options.onBericht?.({
          turnIndex: turn.turnIndex,
          role,
          tekens: content.length,
          stap: 'weggeschreven',
        });
      } catch (fout) {
        this.options.onBericht?.({
          turnIndex: turn.turnIndex,
          role,
          tekens: content.length,
          stap: `NIET WEGGESCHREVEN: ${fout instanceof Error ? fout.message : String(fout)}`,
        });
      }
    };

    // De cliënt eerst: de volgorde in `messages` hoort de volgorde van het gesprek te zijn.
    await schrijf('client', turn.clientUtterance, {
      clientUtteranceWasCut: turn.clientUtteranceWasCut,
    });

    const erkenning = this.erkenningVanBeurt;
    this.erkenningVanBeurt = null;

    let inhoud = turn.assistantContent;
    let knip = turn.interruptedAtChar;

    if (erkenning && inhoud.startsWith(erkenning)) {
      // De erkenning is met een spatie erachter geyield; die hoort bij het afgesplitste
      // stuk en niet bij het antwoord.
      const prefix = inhoud.slice(0, erkenning.length + 1);
      inhoud = inhoud.slice(prefix.length);

      if (knip !== null && knip < prefix.length) {
        /*
         * De onderbreking viel middenin de erkenning.
         *
         * Dan is het antwoord nooit begonnen. De erkenning krijgt de knip, en er volgt geen
         * assistent-bericht — zou dat er wel zijn, dan staat er tekst in het transcript die
         * niemand heeft gehoord.
         */
        await schrijf('assistant', `${ERKENNING_MARKERING}${erkenning}`, {
          interruptedAtChar: knip,
          spokenMs: turn.spokenMs,
        });
        return;
      }

      await schrijf('assistant', `${ERKENNING_MARKERING}${erkenning}`, {
        interruptedAtChar: null,
      });
      if (knip !== null) knip -= prefix.length;
    }

    await schrijf('assistant', inhoud, {
      intendedContent: turn.intendedContent,
      interruptedAtChar: knip,
      spokenMs: turn.spokenMs,
      plannedQuestionKeys: [...(turn.plannedQuestionKeys ?? [])],
    });
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
    // Bewust ná onObservation en niet erin: de HUD hoort niet te wachten op de database, en
    // een mislukte schrijfactie mag de volgende beurt niet ophouden.
    await this.legVast(resultaat);
    return resultaat;
  }

  /**
   * De koude weg naar het dossier: feiten, signalen, voortgang.
   *
   * ## Waarom dit hier staat en niet in live/server.ts
   *
   * Dezelfde afspraak als bij het transcript: de aanroep hoort in de laag die het gesprek
   * voert, niet in de laag die het transport doet. `live/server.ts` is het bestand dat
   * verdwijnt als het transport ooit verandert.
   *
   * ## Waarom elke schrijfactie apart wordt gemeld
   *
   * Een feit dat niet landt, is van buiten niet te onderscheiden van een feit dat de cliënt
   * nooit heeft verteld. De advocaat ziet een leeg dossier en concludeert dat er niets is
   * verteld. Daarom per feit een melding, en bij een fout de reden erbij — niet één
   * verzamelmelding achteraf.
   *
   * ## Waarom een fout de beurt niet afbreekt
   *
   * Dit draait op de koude weg, ná het antwoord. Een gesprek afkappen omdat één feit niet
   * kon worden weggeschreven, kost de cliënt meer dan het oplevert. Wat het niet mag zijn is
   * stil, en dat is het niet.
   */
  private async legVast(resultaat: ObservationResult): Promise<void> {
    const rpc = this.options.rpc;
    if (!rpc) {
      for (const update of resultaat.factUpdates) {
        this.options.onVastlegging?.({
          soort: 'feit',
          sleutel: update.key,
          stap: 'NIET VASTGELEGD: geen verbinding met het dossier',
        });
      }
      return;
    }

    for (const update of resultaat.factUpdates) {
      try {
        await rpc.upsertFact({
          key: update.key,
          value: update.value,
          valueType: update.valueType,
          status: update.status,
          confidence: update.confidence,
          source: update.source,
          sourceRef: update.sourceRef || null,
          /*
           * Het citaat gaat mee, en dat is geen extra.
           *
           * `evidence_quote` is waarop een advocaat kan nagaan waaróm er iets in het dossier
           * staat. Zonder dat is een feit een bewering van een model, en dan is een verkeerd
           * bedrag niet van een goed bedrag te onderscheiden zonder het hele transcript te
           * herlezen. De citaatverankering weigert al wat niet in het transcript staat.
           */
          evidenceQuote: update.evidenceQuote || null,
        });
        this.options.onVastlegging?.({ soort: 'feit', sleutel: update.key, stap: 'vastgelegd' });
      } catch (fout) {
        this.options.onVastlegging?.({
          soort: 'feit',
          sleutel: update.key,
          stap: `NIET VASTGELEGD: ${fout instanceof Error ? fout.message : String(fout)}`,
        });
      }
    }

    for (const vlag of resultaat.riskFlags) {
      try {
        await rpc.setRiskFlag({
          ruleKey: vlag.ruleKey,
          level: vlag.level as 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL',
          label: vlag.label,
          // 'rule': deze komen uit de regelmachine over de feiten, niet uit een modeloordeel.
          // Het wanhoopspad zet 'rule+ai', en dat onderscheid hoort zichtbaar te blijven —
          // een advocaat mag weten of een signaal is afgeleid of ingeschat.
          detectedBy: 'rule',
          sourceRef: null,
        });
        this.options.onVastlegging?.({
          soort: 'signaal',
          sleutel: vlag.ruleKey,
          stap: 'vastgelegd',
        });
      } catch (fout) {
        this.options.onVastlegging?.({
          soort: 'signaal',
          sleutel: vlag.ruleKey,
          stap: `NIET VASTGELEGD: ${fout instanceof Error ? fout.message : String(fout)}`,
        });
      }
    }

    try {
      /*
       * `completeness` en `subject`.
       *
       * `status` blijft van de mens: de RPC laat de agent hoogstens naar READY_FOR_REVIEW,
       * maar wanneer een intake dat is, hoort niet door een teller te worden bepaald.
       *
       * `subject` volgt deterministisch uit de feiten (`onderwerpVan`) en niet uit een model —
       * het is de kolom waarop een advocaat kiest wat hij opent, en daar hoort geen bewering
       * zonder citaat te staan. Zie RISICOS.md risico 24.
       *
       * Hier en niet één keer aan het eind: zo beweegt het onderwerp mee. Vroeg in het gesprek
       * staat er "Ontslag", en zodra de route vaststaat "Ontslag op staande voet". Levert de
       * regel niets op, dan gaat er `null` mee en blijft de kolom leeg — de RPC doet
       * `coalesce`, dus een leeg onderwerp overschrijft nooit een gevuld.
       */
      const onderwerp = onderwerpVan(this.facts);
      await rpc.updateProgress({
        completeness: resultaat.completeness,
        subject: onderwerp?.tekst ?? null,
      });
      this.options.onVastlegging?.({
        soort: 'voortgang',
        sleutel: `volledigheid ${Math.round(resultaat.completeness * 100)}%`,
        stap: 'vastgelegd',
      });
      if (onderwerp) {
        this.options.onVastlegging?.({
          soort: 'voortgang',
          // De bronnen erbij: zonder die is achteraf niet te zien waaróp het onderwerp rustte,
          // en dat is precies wat een verouderd onderwerp onherkenbaar maakt.
          sleutel: `onderwerp "${onderwerp.tekst}" (uit ${onderwerp.bronnen.join(', ')})`,
          stap: 'vastgelegd',
        });
      }
    } catch (fout) {
      this.options.onVastlegging?.({
        soort: 'voortgang',
        sleutel: 'volledigheid',
        stap: `NIET VASTGELEGD: ${fout instanceof Error ? fout.message : String(fout)}`,
      });
    }
  }

  /**
   * Een beurt waarin de cliënt iets zei dat niet is verstaan, als regel in het transcript.
   *
   * ## Waarom dit er hoort te staan
   *
   * Een overgeslagen beurt liet nergens een spoor na. `onSkippedTurn` ging naar de browser en
   * naar het worker-log, en het transcript dat een advocaat leest, las als een doorlopend
   * gesprek. Wat er ontbrak was niet te zien — en dat is precies wat een dossier onbruikbaar
   * maakt: het ziet er compleet uit.
   *
   * ## Alleen bij dataverlies, niet bij elk geluid
   *
   * Een kuch, een deur, een stoel: daar is geen taal in en er gaat niets verloren. Zou daar ook
   * een regel voor komen, dan staat het transcript vol meldingen die niets betekenen — en dan
   * leest niemand ze meer, ook de regel niet die er wél toe doet.
   *
   * ## Waarom de tekst zo is
   *
   * Een advocaat moet begrijpen dát er iets niet is verstaan, en niet hoeven weten wat
   * `utterance_end` of `speech_final` betekent. Geen regelnaam, geen code, geen aantal tekens:
   * dat aantal is bovendien de lengte van een tussentijds transcript en geen maat voor hoeveel
   * er is gezegd. Wat er staat is wat er waar is: hier is iets gezegd en het staat er niet.
   */
  async meldOvergeslagenBeurt(): Promise<void> {
    /*
     * De index komt van de sessie zelf en niet van de aanroeper.
     *
     * De beurt is nooit voltooid, dus de lus heeft er geen nummer voor.
     *
     * `history.length` was fout: die lijst bevat twee regels per beurt — de cliëntuitspraak en
     * het antwoord — dus de melding belandde op ongeveer het dubbele. In een gesprek van 31
     * beurten kwam hij op index 54 te staan, ver achter het einde, terwijl het gat bij beurt 27
     * viel. Precies de plek waar hij hoorde te staan, was de plek waar hij níét stond.
     */
    const turnIndex = Math.floor(this.history.length / 2);
    // Eén tekst, gedeeld met het cliëntscherm. Zie niet-verstaan.ts.
    const tekst = NIET_VERSTAAN[this.options.language ?? 'nl'];

    if (!this.options.rpc) {
      this.options.onBericht?.({
        turnIndex,
        role: 'system',
        tekens: tekst.length,
        stap: 'NIET WEGGESCHREVEN: geen verbinding met het dossier',
      });
      return;
    }
    try {
      await this.options.rpc.appendMessage({ turnIndex, role: 'system', content: tekst });
      this.options.onBericht?.({
        turnIndex,
        role: 'system',
        tekens: tekst.length,
        stap: 'weggeschreven',
      });
    } catch (fout) {
      this.options.onBericht?.({
        turnIndex,
        role: 'system',
        tekens: tekst.length,
        stap: `NIET WEGGESCHREVEN: ${fout instanceof Error ? fout.message : String(fout)}`,
      });
    }
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
      ...(this.options.knownFromForm ? { knownFromForm: this.options.knownFromForm } : {}),
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
