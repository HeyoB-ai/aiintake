import { readPublicEnv, readServerEnv } from '@intake/db';
import { assertGeenWorkergeheim } from './lib/geen-workergeheim';

/**
 * De omgeving controleren zodra de server start, niet zodra een bezoeker langskomt.
 *
 * ## Waarom dit bestand er moest komen
 *
 * `readPublicEnv` en `readServerEnv` stonden al in `packages/db/src/env.ts`, compleet met
 * schema's en een foutmelding die de ontbrekende variabele noemt. Ze werden alleen nergens
 * aangeroepen. Een validatie die niemand draait is geen validatie; hij ziet er in het
 * codebeeld uit alsof deze grens bewaakt wordt en doet niets.
 *
 * Wat er in plaats daarvan gebeurde met een half ingevulde omgeving op Netlify: de
 * middleware roept `createServerClient(url, key)` aan met `key` op `undefined` — de `!`
 * achter `process.env[...]` belooft de compiler dat hij er is — en de Supabase-client gooit
 * dan pas, bij het eerste verzoek. De bezoeker krijgt een 500, de router krijgt HTML waar
 * hij een RSC-payload verwacht, en de melding in de browser is "An unexpected response was
 * received from the server". Die zin bevat geen enkele aanwijzing dat er een
 * omgevingsvariabele ontbreekt.
 *
 * Dezelfde vorm als de fantoomafhankelijkheid en als het sessietoken dat nooit werd
 * gecontroleerd: iets dat stil doorloopt op een aanname, en pas ver van de oorzaak zichtbaar
 * wordt. Hier hoort het bij het opstarten te knallen, met de naam van de variabele erbij.
 *
 * ## Waarom niet tijdens de build
 *
 * Een buildmachine hoort de runtime-geheimen niet te hebben — `SUPABASE_SECRET_KEY` op de
 * bouwstap zetten is precies wat we niet willen. `NEXT_PHASE` staat tijdens `next build` op
 * `phase-production-build`; dan slaat deze controle over. Dat is geen gat: de variabelen die
 * daadwerkelijk in de bundel gebakken worden, worden hieronder alsnog gecontroleerd op het
 * moment dat de server ze nodig heeft, en geen enkele clientcomponent leest ze zelf.
 *
 * ## Waarom alleen de Node-runtime
 *
 * `register()` draait ook voor de edge-runtime, waar de middleware leeft. Die kent de
 * server-only variabelen niet en hoort ze ook niet te kennen. Twee keer dezelfde controle
 * met een andere uitkomst zou alleen verwarring geven over welke van de twee waar is.
 */
export async function register(): Promise<void> {
  if (process.env['NEXT_PHASE'] === 'phase-production-build') return;
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;

  /*
   * Eerst, en apart van de rest.
   *
   * Dit is geen ontbrekende variabele maar een die er níét hoort te zijn, en het is de
   * spiegel van de controle in apps/agent. Hij staat vóór de volledigheidscontrole omdat een
   * te ruime omgeving erger is dan een te krappe: een ontbrekende variabele geeft een
   * storing, een te veel gedeeld geheim geeft er geen.
   */
  assertGeenWorkergeheim();

  const ontbreekt: string[] = [];

  // Apart afgehandeld, want ze falen om verschillende redenen en een lezer moet beide
  // meldingen tegelijk zien in plaats van ze een deploy uit elkaar te moeten halen.
  try {
    readPublicEnv();
  } catch (fout) {
    ontbreekt.push(fout instanceof Error ? fout.message : String(fout));
  }
  try {
    readServerEnv();
  } catch (fout) {
    ontbreekt.push(fout instanceof Error ? fout.message : String(fout));
  }

  /*
   * Een `ws://`-adres op een `https`-site is geen configuratiesmaak maar een kapot gesprek.
   *
   * Het cliëntscherm controleert deze combinatie zelf ook en weigert met de reden erbij,
   * maar dat is één scherm ver van de oorzaak. Hier is hij op het moment dat iemand hem
   * heeft gezet.
   */
  const ws = process.env['NEXT_PUBLIC_AGENT_WS_URL'];
  if (process.env.NODE_ENV === 'production' && ws?.startsWith('ws://')) {
    ontbreekt.push(
      'NEXT_PUBLIC_AGENT_WS_URL is ws:// terwijl de site op https draait; ' +
        'browsers blokkeren die combinatie als gemengde inhoud, zonder melding',
    );
  }

  if (ontbreekt.length > 0) {
    throw new Error(
      `De omgeving van apps/web is niet compleet:\n  - ${ontbreekt.join('\n  - ')}\n\n` +
        'Zie docs/deploy.md voor welke variabele waar hoort. De server start niet zonder; ' +
        'een halve configuratie geeft anders een 500 op de eerste bezoeker.',
    );
  }
}
