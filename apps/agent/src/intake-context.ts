import {
  createAgentClient,
  createAgentRpc,
  type AgentContext,
  type AgentRpc,
} from '@intake/db-core';
import {
  OrgConfigSchema,
  type CaseFact,
  type Language,
  type OrgConfig,
  type Turn,
} from '@intake/domain';

/**
 * De worker haalt op wie hij tegenover zich heeft.
 *
 * ## Waarom dit bestand bestaat
 *
 * `live/server.ts` draaide op een hardgecodeerde `ORG` — "Kantoor De Vries", een vast
 * UUID — en wist verder niets van de intake waarvoor hij was opgeroepen. De cliënt had
 * zijn naam op het toestemmingsscherm ingetypt en de assistent begroette hem niet, want
 * de worker had die naam nooit gezien.
 *
 * `agent_context` bestond al en leverde dit allemaal. Hij werd alleen nergens aangeroepen:
 * zeven van de negen agent-RPC's stonden ongebruikt (risico 15). Dit is de eerste ervan.
 *
 * ## Waarom hier en niet in live/server.ts
 *
 * De aanroep hoort in de laag die het gesprek voert, niet in de laag die het transport
 * doet. `live/server.ts` is het bestand dat verdwijnt als het transport ooit verandert;
 * alles wat hier staat verhuist dan mee zonder aanpassing. Dat is geen netheid maar de
 * afspraak uit het beslisdocument over weg A.
 *
 * ## Wat er met een fout gebeurt
 *
 * Niets stils. Lukt het ophalen niet, dan gooit deze functie — en de aanroeper moet dan
 * beslissen of hij het gesprek weigert of doorgaat op minder. Een lege context stilzwijgend
 * teruggeven zou betekenen dat de assistent zich gedraagt alsof het kantoor niet bestaat
 * en de cliënt geen naam heeft, en dat is van buiten niet te onderscheiden van een cliënt
 * die niets heeft ingevuld.
 */

export interface IntakeContext {
  readonly rpc: AgentRpc;
  readonly sessionId: string;
  readonly organization: OrgConfig;
  readonly language: Language;
  /** Wat de cliënt zelf heeft ingevuld. `null` als het veld leeg is gebleven. */
  readonly clientName: string | null;
  /** Wat er al vaststaat uit eerdere beurten van deze intake. */
  readonly facts: Record<string, CaseFact>;
  /** Het transcript tot nu toe; bij een eerste gesprek leeg. */
  readonly history: Turn[];
  readonly pendingLawyerRequests: readonly string[];
  /**
   * Feitsleutels die de cliënt op het toestemmingsscherm heeft ingevuld.
   *
   * Voor `client_full_name` staat de waarde erbij (als gezaaid feit); voor e-mail en telefoon
   * weet de worker alleen dát ze zijn ingevuld. Zie de toelichting bij `haalIntakeContext`.
   */
  readonly knownFromForm: readonly string[];
}

export interface ContextOptions {
  readonly supabaseUrl: string;
  readonly publishableKey: string;
  readonly sessionToken: string;
  readonly intakeId: string;
}

/**
 * De organisatie uit de database naar `OrgConfig`.
 *
 * De RPC levert snake_case uit Postgres; het domein werkt in camelCase met zod-defaults.
 * Die vertaling staat hier expliciet en niet als een `as OrgConfig`-cast: een cast zou een
 * ontbrekend veld pas laten opvallen op het moment dat iets het leest, en dat is midden in
 * een gesprek.
 */
function naarOrgConfig(rauw: Record<string, unknown>): OrgConfig {
  return OrgConfigSchema.parse({
    id: rauw['id'],
    slug: rauw['slug'],
    name: rauw['name'],
    defaultLanguage: rauw['default_language'] ?? 'nl',
    timeZone: rauw['time_zone'] ?? 'Europe/Amsterdam',
    providerConfig: rauw['provider_config'] ?? {},
    sessionLimits: rauw['session_limits'] ?? {},
    intakeCriteria: rauw['intake_criteria'] ?? {},
    retentionPolicy: rauw['retention_policy'] ?? {},
    publishClientVideo: rauw['publish_client_video'] ?? false,
  });
}

/**
 * Het transcript uit de database naar de vorm die de engine verwacht.
 *
 * `content` is wat de cliënt daadwerkelijk heeft gehóórd — de kolom is al getrunceerd op
 * `spokenMs` bij het wegschrijven. Hier gebeurt dus niets meer met afkappen; zou dat hier
 * ook staan, dan zijn er twee plekken die hetzelfde oordeel vellen.
 */
/**
 * Alleen voor de test die de uitsluiting bewaakt.
 *
 * De functie zelf blijft privé — hij is een vertaalstap en geen API. Maar wat hij uitsluit is
 * een afspraak die stil te breken is, en die hoort vastgehouden te worden door iets dat rood
 * wordt. Zie vastlegging.test.ts.
 */
export function naarGeschiedenisVoorTest(rijen: AgentContext['history']): Turn[] {
  return naarGeschiedenis(rijen);
}

function naarGeschiedenis(rijen: AgentContext['history']): Turn[] {
  return (
    rijen
      /*
       * Systeemregels gaan er hier uit, en dat is geen opruimwerk.
       *
       * Sinds een overgeslagen beurt een regel in het transcript krijgt, staan er berichten met
       * rol `system` tussen — "hier heeft de cliënt iets gezegd dat niet is verstaan". Dat is
       * een mededeling van ons over het gesprek, geen uitspraak van de cliënt.
       *
       * Zou zo'n regel als geschiedenis meegaan, dan wordt hij invoer voor de feitextractie en
       * kan hij als grondslag voor een `case_fact` gelden. Dezelfde uitsluiting als bij de
       * erkenning, en om dezelfde reden: alleen wat de cliënt zelf heeft gezegd, mag een feit
       * dragen. `geen-systeemregel-als-grondslag.test.ts` bewaakt dit.
       */
      .filter((m) => m.role === 'client' || m.role === 'assistant')
      .map((m) => ({
        id: m.id,
        role: m.role as 'client' | 'assistant',
        content: m.content,
        plannedQuestionKeys: m.plannedQuestionKeys ?? [],
        createdAt: m.createdAt,
      }))
  );
}

export async function haalIntakeContext(opties: ContextOptions): Promise<IntakeContext> {
  const client = createAgentClient(opties.supabaseUrl, opties.publishableKey);
  const rpc = createAgentRpc(client, {
    sessionToken: opties.sessionToken,
    intakeId: opties.intakeId,
  });

  const context = await rpc.context();

  const intake = context.intake as AgentContext['intake'] & { client_name?: string | null };
  const naam = typeof intake.client_name === 'string' ? intake.client_name.trim() : '';

  const facts: Record<string, CaseFact> = {};
  for (const f of context.facts) {
    facts[f.key] = {
      key: f.key,
      value: f.value,
      valueType: f.valueType as CaseFact['valueType'],
      status: f.status as CaseFact['status'],
      confidence: f.confidence,
      source: f.source as CaseFact['source'],
      sourceRef: f.sourceRef,
      llmCallId: null,
      updatedAt: new Date().toISOString(),
    };
  }

  /*
   * Wat de cliënt zelf heeft ingevuld, telt als feit.
   *
   * Zonder dit vroeg de assistent naar een naam die ze net had uitgesproken. Gemeten:
   * "Volle naam van u — hoe heet u precies?" gevolgd door "Dat weet je toch?".
   *
   * De naam staat op `intakes.client_name` en komt via `agent_context` binnen; de planner
   * kijkt naar `case_facts` en zag daar niets. Nu zit hij er wél in, met `client_form` als
   * herkomst — geen `client_statement`, want er is geen citaat en dat hoort er ook niet te
   * komen. Zie de migratie van 27 augustus 2026.
   *
   * E-mail en telefoon gaan bewust níét mee in deze RPC: de worker heeft ze niet nodig om een
   * gesprek te voeren, en wat hij niet krijgt kan hij niet in een prompt laten belanden. Ze
   * worden daarom niet als feit gezaaid maar overgeslagen door de planner — zie
   * `alReedsIngevuld` hieronder.
   */
  const contact = (context as { clientContact?: { hasEmail?: boolean; hasPhone?: boolean } })
    .clientContact;
  const uitFormulier: string[] = [];
  if (contact?.hasEmail) uitFormulier.push('client_email');
  if (contact?.hasPhone) uitFormulier.push('client_phone');

  if (naam !== '') {
    uitFormulier.push('client_full_name');
    facts['client_full_name'] = {
      key: 'client_full_name',
      value: naam,
      valueType: 'string',
      status: 'confirmed',
      confidence: 1,
      source: 'client_form',
      sourceRef: null,
      llmCallId: null,
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    rpc,
    sessionId: context.sessionId,
    organization: naarOrgConfig(context.organization),
    language: (intake.language === 'en' ? 'en' : 'nl') as Language,
    clientName: naam === '' ? null : naam,
    facts,
    history: naarGeschiedenis(context.history),
    pendingLawyerRequests: context.pendingLawyerRequests,
    knownFromForm: uitFormulier,
  };
}
