/**
 * De koude weg afwachten voordat de sessie sluit.
 *
 * ## Wat er misging
 *
 * Het sessietoken wordt bij `agent_end_session` ingetrokken. De extractie draait buiten de
 * beurtklok en kost een modelaanroep van seconden. Wie eerst sluit en dan schrijft, schrijft
 * dus niet — en dat gebeurde bij élk gesprek:
 *
 *     feit currently_ill      · NIET VASTGELEGD: geen geldig agent-token
 *     feit workplace_conflict · NIET VASTGELEGD: geen geldig agent-token
 *     voortgang volledigheid  · NIET VASTGELEGD: geen geldig agent-token
 *
 * Gemeten over 25 beëindigde sessies: **nul** feiten geschreven ná `ended_at`, en bij vijf van
 * de zes gesprekken viel het laatste feit binnen 30 seconden vóór het einde. De race werd nooit
 * gewonnen; hij werd alleen niet gezien, want de melding is dezelfde als bij een ongeldig
 * token.
 *
 * ## Waarom wachten en niet het token laten leven
 *
 * De tweede optie zou een beveiligingseigenschap opgeven voor een race: intrekken bij
 * sessie-einde is precies wat ADR-0007 als voordeel van een opaque token noemt tegenover een
 * JWT. Wachten kost hooguit seconden aan het einde van een gesprek, wanneer de cliënt de
 * afsluitzin al heeft gehoord.
 *
 * ## Waarom een grens, en waarom die luid is
 *
 * Blijft de extractie hangen, dan zou eeuwig wachten `ended_at` op null laten staan — en
 * precies dát legde de dienst eerder plat, want een sessie die nooit eindigt blijft de
 * gelijktijdigheidslimiet van het kantoor vullen. Er is dus een grens.
 *
 * Wordt die gehaald, dan gaan er alsnog feiten verloren. Dat hoort in het log te staan. Stil
 * afkappen zou hetzelfde verlies opleveren als hiervoor, alleen zonder melding.
 */

export interface KoudeWegKeten {
  /** Registreer werk dat naar het dossier moet. Fouten worden geslikt; zie `volg`. */
  volg(werk: Promise<unknown>): void;
  /** Wacht tot alles klaar is, of tot de grens. Geeft terug wat er is gebeurd. */
  wacht(maxMs?: number): Promise<KoudeWegUitkomst>;
  /** Hoeveel stukken werk er zijn geregistreerd. Nul betekent: niets te wachten. */
  readonly aantal: number;
}

export type KoudeWegUitkomst =
  | { readonly stand: 'niets' }
  | { readonly stand: 'af'; readonly duurMs: number }
  | { readonly stand: 'afgekapt'; readonly duurMs: number };

export interface KoudeWegOpties {
  /** Injecteerbaar zodat een test niet echt hoeft te wachten. */
  readonly now?: () => number;
  readonly setTimeoutFn?: (fn: () => void, ms: number) => unknown;
}

export function maakKoudeWeg(opties: KoudeWegOpties = {}): KoudeWegKeten {
  const now = opties.now ?? (() => Date.now());
  const wacht = opties.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));

  /*
   * Sequentieel aan elkaar geregen en niet als verzameling.
   *
   * De observaties komen toch al op volgorde binnen — de ene beurt na de andere — en zo is
   * "wachten tot alles klaar is" één promise in plaats van een lijst die tijdens het wachten
   * nog kan groeien.
   */
  let keten: Promise<void> = Promise.resolve();
  let aantal = 0;

  return {
    get aantal() {
      return aantal;
    },

    volg(werk: Promise<unknown>): void {
      aantal += 1;
      /*
       * Fouten slikken, en dat is geen onverschilligheid.
       *
       * De aanroeper handelt zijn eigen fout al af (hij stuurt hem naar de browser). Zou een
       * afwijzing hier doorlopen, dan valt de hele keten om en houdt één mislukte extractie
       * het afsluiten van de sessie tegen — met `ended_at` op null als gevolg.
       */
      keten = keten
        .then(() => werk)
        .then(
          () => undefined,
          () => undefined,
        );
    },

    async wacht(maxMs = 15_000): Promise<KoudeWegUitkomst> {
      if (aantal === 0) return { stand: 'niets' };

      const start = now();
      let af = false;
      await Promise.race([
        keten.then(() => {
          af = true;
        }),
        new Promise<void>((r) => {
          wacht(() => r(), maxMs);
        }),
      ]);

      const duurMs = now() - start;
      return af ? { stand: 'af', duurMs } : { stand: 'afgekapt', duurMs };
    },
  };
}

/**
 * De logregel. `null` als er niets te melden valt.
 *
 * Een afgekapte keten is altijd luid: daar gaan feiten verloren. Een keten die binnen enkele
 * milliseconden af is, hoeft niets te zeggen — dat is de normale gang van zaken en elke regel
 * die altijd verschijnt, wordt niet meer gelezen.
 */
export function koudeWegRegel(uitkomst: KoudeWegUitkomst, maxMs = 15_000): string | null {
  if (uitkomst.stand === 'niets') return null;
  if (uitkomst.stand === 'af') {
    return uitkomst.duurMs > 50
      ? `    koude weg afgewacht (${uitkomst.duurMs} ms) voor het afsluiten`
      : null;
  }
  return (
    `    KOUDE WEG NIET AF na ${maxMs} ms — de sessie wordt nu afgesloten en wat er nog liep, ` +
    'kan niet meer naar het dossier. Feiten uit de laatste beurten ontbreken.'
  );
}
