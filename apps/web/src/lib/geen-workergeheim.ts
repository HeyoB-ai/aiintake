/**
 * De web-app weigert te starten als het workergeheim in háár omgeving staat.
 *
 * ## De spiegel van een bestaande controle
 *
 * `apps/agent/src/geen-geheime-sleutel.ts` weigert een worker met `SUPABASE_SECRET_KEY`.
 * Dit is dezelfde regel de andere kant op, en om dezelfde reden: de grens tussen de twee
 * processen is de hele beveiliging, en een sjabloon dat zegt "kopieer dit blok naar beide"
 * haalt hem in één keer weg.
 *
 * ## Waarom dit geen theoretisch risico is
 *
 * Staat het workergeheim bij de web-app, dan is de tweede factor van risico 31 weg. Niet
 * omdat er dan iets lekt — de web-app is server-side en de variabele belandt niet in de
 * bundel — maar omdat het geheim dan op twee plekken staat, in twee dashboards, bij twee
 * deploys. Dat is de manier waarop geheimen uiteindelijk in een logregel, een screenshot of
 * een gekopieerde `.env` terechtkomen.
 *
 * De web-app heeft hem ook nergens voor nodig. Zij zet het geheim (via
 * `set_worker_secret`, met de secret key) en gebruikt het nooit.
 *
 * ## Waarom op naam én op vorm
 *
 * Hernoemen mag niet helpen. Het geheim is 43 tekens base64url — dezelfde vorm als een
 * sessietoken — en dat is te weinig onderscheidend om op zichzelf op te herkennen. Daarom
 * de naam als hoofdregel, en de bekende varianten erbij: wie hem overzet, doet dat met
 * kopiëren en plakken, inclusief de naam.
 */

const VERBODEN_NAMEN: readonly string[] = [
  'AGENT_WORKER_SECRET',
  'WORKER_SECRET',
  'AGENT_WORKER_GEHEIM',
];

export interface Bevinding {
  readonly naam: string;
}

/**
 * De bevindingen, zonder te gooien. Puur, zodat er een test op kan die geen proces sloopt.
 *
 * Geeft nooit de waarde terug, ook niet afgekort. Een foutmelding belandt in een logdienst
 * en dat is de laatste plek waar een geheim hoort te staan.
 */
export function vindWorkergeheim(
  omgeving: Record<string, string | undefined>,
): readonly Bevinding[] {
  return VERBODEN_NAMEN.filter((naam) => naam in omgeving).map((naam) => ({ naam }));
}

/**
 * Bij het opstarten aanroepen.
 *
 * Gooit in productie en waarschuwt daarbuiten — dezelfde afweging als bij de worker: lokaal
 * deelt dit project één `.env`, en hard falen zou betekenen dat de controle wordt uitgezet
 * in plaats van dat er iets veiliger wordt. De grens die telt is die van de deploy.
 */
export function assertGeenWorkergeheim(
  omgeving: Record<string, string | undefined> = process.env,
): void {
  const bevindingen = vindWorkergeheim(omgeving);
  if (bevindingen.length === 0) return;

  const regels = bevindingen.map((b) => `  - ${b.naam}`).join('\n');

  if (omgeving['NODE_ENV'] !== 'production') {
    console.warn(
      '\n  Let op: het workergeheim staat in de omgeving van apps/web.\n' +
        regels +
        '\n  Lokaal is dat de gedeelde .env. Bij de hostingpartij hoort deze variabele\n' +
        '  uitsluitend bij de worker; daar weigert de web-app te starten.\n',
    );
    return;
  }

  throw new Error(
    'apps/web weigert te starten: het workergeheim staat in haar omgeving.\n' +
      regels +
      '\n\nDeze variabele hoort uitsluitend bij de worker (Railway). De web-app zet het\n' +
      'geheim met scripts/set-worker-secret.mjs en gebruikt het daarna nooit.\n' +
      'Zie RISICOS.md risico 31.',
  );
}
