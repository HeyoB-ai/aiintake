import type { AppClient } from '@intake/db-core';

/**
 * Het workergeheim: de tweede factor waarmee de database de worker van de browser
 * onderscheidt.
 *
 * ## Waarom dit bestaat
 *
 * Zie RISICOS.md risico 31. Het sessietoken bewijst wélke intake, maar de browser van de
 * cliënt heeft dat token ook — het komt mee in de WebSocket-URL — en de publiceerbare
 * sleutel staat in de bundel. Daarmee kon een cliënt een assistent-beurt in zijn eigen
 * dossier schrijven die van een echte niet te onderscheiden is.
 *
 * Het geheim staat alleen bij de worker. `app.assert_agent_scope` weigert zonder.
 *
 * ## Waarom de worker het bij het opstarten controleert
 *
 * Anders is "het geheim staat verkeerd in Railway" een storing die pas midden in een gesprek
 * zichtbaar wordt, en dan als een mislukte feitschrijving — met een foutmelding die naar het
 * sessietoken wijst, want de database geeft opzettelijk dezelfde fout voor beide helften.
 * Dat is precies het soort spoor waar je een avond aan kwijt bent.
 *
 * `agent_verify_worker()` is er om die vraag één keer te stellen, op het moment dat het
 * antwoord nog goedkoop is.
 */

/** De naam van de omgevingsvariabele. Uitsluitend bij de worker; apps/web weigert hem. */
export const WORKERGEHEIM_ENV = 'AGENT_WORKER_SECRET';

export function leesWorkergeheim(
  omgeving: Record<string, string | undefined> = process.env,
): string | undefined {
  const rauw = omgeving[WORKERGEHEIM_ENV];
  if (typeof rauw !== 'string') return undefined;
  const geheim = rauw.trim();
  return geheim === '' ? undefined : geheim;
}

export type Herkenning =
  | { readonly stand: 'herkend' }
  | { readonly stand: 'niet-gezet' }
  | { readonly stand: 'niet-herkend' }
  | { readonly stand: 'onbereikbaar'; readonly fout: string };

/**
 * Vraagt de database of zij deze worker herkent.
 *
 * Vier uitkomsten en niet twee, omdat ze om verschillende dingen vragen:
 *
 *   `herkend`       alles klopt.
 *   `niet-gezet`    er staat geen geheim in de omgeving. Vóór het afdwingen is dat de
 *                   normale stand; erna is het een storing.
 *   `niet-herkend`  er staat een geheim en de database kent het niet. Dat is de gevaarlijke
 *                   uitkomst: alles lijkt goed geconfigureerd en niets werkt straks.
 *   `onbereikbaar`  de vraag kon niet gesteld worden. Dat zegt niets over het geheim, en
 *                   het mag de worker dus ook niet tegenhouden.
 */
export async function controleerWorkergeheim(
  client: AppClient,
  geheim: string | undefined,
): Promise<Herkenning> {
  if (geheim === undefined) return { stand: 'niet-gezet' };

  const { data, error } = await client.rpc('agent_verify_worker');
  if (error) {
    /*
     * Ook de functie-bestaat-niet-fout komt hier terecht, en dat is juist goed: zolang
     * migratie 20260828120000 niet is gepusht, is er niets af te dwingen en hoort de worker
     * gewoon te draaien.
     */
    return { stand: 'onbereikbaar', fout: error.message };
  }
  return data === true ? { stand: 'herkend' } : { stand: 'niet-herkend' };
}

/**
 * De regel voor het opstartlog. Altijd melden, ook als alles goed is.
 *
 * Een controle die alleen praat als er iets mis is, is niet te onderscheiden van een
 * controle die niet draait — en dat is precies hoe risico 31 zo lang onzichtbaar bleef.
 */
export function workergeheimBanner(h: Herkenning): string {
  switch (h.stand) {
    case 'herkend':
      return '  workergeheim: herkend';
    case 'niet-gezet':
      return `  workergeheim: NIET GEZET — ${WORKERGEHEIM_ENV} ontbreekt; schrijven naar het dossier werkt niet zodra de afdwinging staat`;
    case 'niet-herkend':
      return '  workergeheim: NIET HERKEND — er staat een geheim maar de database kent het niet';
    case 'onbereikbaar':
      return `  workergeheim: niet te controleren (${h.fout})`;
  }
}

/**
 * Moet de worker hierop weigeren te starten?
 *
 * Alleen bij `niet-herkend`, en alleen in productie. De redenering per geval:
 *
 * `niet-herkend` is de enige stand waarin alles er goed uitziet en niets werkt. Het geheim
 * staat er, de deploy is geslaagd, de worker accepteert verbindingen — en elke feitschrijving
 * faalt straks met een melding over het sessietoken. Doorstarten betekent gesprekken voeren
 * die niet in het dossier belanden, en dat is erger dan niet starten.
 *
 * `niet-gezet` niet, want dat is de normale stand tussen de twee migraties in: deel 1 staat
 * er, het geheim nog niet, en de worker hoort dan gewoon te draaien. De banner zegt het luid.
 *
 * `onbereikbaar` niet, want dat zegt niets over het geheim. Een worker laten weigeren op een
 * netwerkstoring maakt van een tijdelijk probleem een harde storing.
 */
export function moetWeigeren(
  h: Herkenning,
  omgeving: Record<string, string | undefined> = process.env,
): boolean {
  return h.stand === 'niet-herkend' && omgeving['NODE_ENV'] === 'production';
}
