'use server';

import { headers } from 'next/headers';
import { z } from 'zod';
import { issueAgentSession } from '@intake/db';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service';
import { bepaalClientIp, hashMetPeper } from '@/lib/client-ip';

/**
 * Toestemming vastleggen en een gesprek klaarzetten.
 *
 * Twee stappen die niet los mogen staan: zonder vastgelegde toestemming hoort er geen
 * sessie te zijn, en een sessie die is uitgegeven zonder toestemming is een sessie die
 * niemand kan verantwoorden. `create_public_intake` weigert daarom zelf als een van beide
 * vinkjes ontbreekt — dat oordeel staat in de database en niet hier, zodat het niet te
 * omzeilen is door een tweede client te schrijven.
 */

/**
 * Leeg is afwezig.
 *
 * Een veld dat is aangeraakt en weer leeggemaakt levert `''` op. Dat zou als "ingevuld"
 * tellen bij de controle op minstens één contactkanaal, en dan komt er een intake binnen
 * met een leeg e-mailadres en geen telefoonnummer.
 */
const Optioneel = z
  .string()
  .trim()
  .transform((s) => (s === '' ? undefined : s))
  .optional();

const ToestemmingSchema = z.object({
  organizationSlug: z.string().min(2).max(60),
  privacyAccepted: z.boolean(),
  aiDisclosureAccepted: z.boolean(),
  cameraConsent: z.boolean(),
  microphoneConsent: z.boolean(),
  privacyPolicyVersion: z.string().min(1),
  aiDisclosureVersion: z.string().min(1),
  clientName: z.string().trim().min(2).max(200),
  clientEmail: Optioneel,
  clientPhone: Optioneel,
});

export interface GesprekKlaar {
  readonly ok: true;
  readonly intakeId: string;
  readonly wsUrl: string;
}

export interface GesprekMislukt {
  readonly ok: false;
  readonly fout: string;
}

/**
 * Een hash van het IP, niet het IP zelf.
 *
 * De rate limiting heeft alleen nodig dat twee pogingen van dezelfde bron te herkennen
 * zijn. Het adres bewaren zou een persoonsgegeven opslaan waar we niets aan hebben, en dat
 * is precies wat §14 verbiedt.
 *
 * De peper zit in de hash: zonder peper is een gehasht IPv4-adres in seconden terug te
 * rekenen en dus nog steeds een persoonsgegeven. Zie lib/client-ip.ts.
 */
function hashVan(waarde: string | null): string {
  return hashMetPeper(waarde, process.env['INTAKE_IP_HASH_PEPPER']);
}

export async function startIntake(
  invoer: z.input<typeof ToestemmingSchema>,
): Promise<GesprekKlaar | GesprekMislukt> {
  /*
   * Onvoorwaardelijk, als eerste regel, en dat is de hele functie ervan.
   *
   * Alle takken hieronder loggen hun eigen oorzaak, dus als er een foutmelding bij de
   * bezoeker verschijnt hoort er een regel in het functielog te staan. Gebeurt dat niet,
   * dan zijn er twee verklaringen die er van buiten identiek uitzien: de action is nooit
   * aangeroepen, of console-uitvoer bereikt dat log niet.
   *
   * Deze regel scheidt die twee. Staat hij er, dan draait de action en landt console-
   * uitvoer — en moet de oorzaak in een van de takken zitten. Staat hij er niet bij een
   * klik die een melding oplevert, dan is die melding niet van deze aanroep afkomstig.
   *
   * Geen persoonsgegevens: alleen de slug en welke velden zijn meegestuurd. Dat laatste is
   * genoeg om een afgekeurd schema te herkennen zonder de inhoud te loggen.
   */
  console.log('intake: startIntake aangeroepen', {
    org: (invoer as { organizationSlug?: unknown })?.organizationSlug,
    velden: invoer && typeof invoer === 'object' ? Object.keys(invoer).sort() : null,
  });

  const parsed = ToestemmingSchema.safeParse(invoer);
  if (!parsed.success) {
    // Ook deze tak: hij was stil, en een afgekeurd schema is precies het geval waarin de
    // client iets anders stuurt dan de server verwacht — na een deploy bijvoorbeeld.
    console.error('intake: invoer afgekeurd', {
      issues: parsed.error.issues.map((i) => ({ pad: i.path.join('.'), code: i.code })),
    });
    return { ok: false, fout: 'De gegevens waren niet volledig. Probeer het opnieuw.' };
  }
  const d = parsed.data;

  if (!d.privacyAccepted || !d.aiDisclosureAccepted) {
    return { ok: false, fout: 'Beide verklaringen moeten zijn aangevinkt.' };
  }
  if (!d.microphoneConsent) {
    return { ok: false, fout: 'Zonder microfoon kan het gesprek niet worden gevoerd.' };
  }

  /*
   * Alles wat kan weigeren, weigert vóór de eerste schrijfactie.
   *
   * Deze controle stond onderaan, ná `create_public_intake` en ná `issueAgentSession`. Bij
   * een ontbrekende `NEXT_PUBLIC_AGENT_WS_URL` liet elke mislukte poging dus een intake én
   * een sessie achter, en op dat foutpad werd niets teruggedraaid. Drie van zulke rijen
   * plus een gesprek dat zijn `ended_at` nooit kreeg, en `maxConcurrentSessions` (5) zit
   * vol — waarna niemand meer een gesprek kan starten en de melding over gelijktijdige
   * sessies gaat, niet over de configuratie die de oorzaak was.
   *
   * De regel die dat voorkomt is niet "draai terug bij een fout" maar "schrijf pas als er
   * niets meer kan weigeren". Daarom wordt de URL hier ook meteen ontleed: `new URL()` op
   * een onzinnige waarde gooit, en dat hoort te gebeuren voordat er een sessie is en niet
   * erna.
   */
  const basis = process.env['NEXT_PUBLIC_AGENT_WS_URL'];
  if (!basis) return { ok: false, fout: 'De gespreksdienst is niet geconfigureerd.' };

  let wsBasis: URL;
  try {
    wsBasis = new URL(basis);
  } catch {
    return { ok: false, fout: 'De gespreksdienst is niet geconfigureerd.' };
  }

  const kop = await headers();

  /*
   * Het adres uit een header die de rand zelf schrijft, niet uit x-forwarded-for.
   *
   * Die laatste mag de bezoeker meesturen, en dan is de limiet van 5 pogingen per uur te
   * omzeilen door elke keer iets anders te verzinnen. Zolang er geen bot-check staat is
   * deze limiet de enige rem op de kosten, dus hij moet aan een adres hangen dat niet van
   * de bezoeker komt. Zie lib/client-ip.ts voor de volgorde.
   */
  const ip = bepaalClientIp((naam) => kop.get(naam));
  if (ip.vervalsbaar && process.env.NODE_ENV === 'production') {
    // Geen stille degradatie. Draait dit in productie zonder randheader, dan is de rate
    // limiting een schijnmaatregel, en dat hoort zichtbaar te zijn in de logs van de dag
    // dat het misgaat — niet pas op de factuur.
    console.warn(
      'intake: geen betrouwbare client-IP-header gevonden; de rate limiting is omzeilbaar. ' +
        'Controleer of de hostingpartij x-nf-client-connection-ip (of gelijkwaardig) zet.',
    );
  }

  const ipHash = hashVan(ip.adres);
  const uaHash = hashVan(kop.get('user-agent'));

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('create_public_intake', {
    p_org_slug: d.organizationSlug,
    p_language: 'nl',
    p_channel: 'video',
    p_ip_hash: ipHash,
    p_privacy_accepted: d.privacyAccepted,
    p_privacy_policy_version: d.privacyPolicyVersion,
    p_ai_disclosure_accepted: d.aiDisclosureAccepted,
    p_ai_disclosure_version: d.aiDisclosureVersion,
    p_camera_consent: d.cameraConsent,
    p_microphone_consent: d.microphoneConsent,
    p_user_agent_hash: uaHash,
    // De functie normaliseert en weigert zelf ook: naam verplicht, minstens één
    // contactkanaal. Dat oordeel hoort in de database en niet alleen hier, zodat een
    // tweede client er niet omheen kan.
    p_client_name: d.clientName,
    p_client_email: d.clientEmail ?? null,
    p_client_phone: d.clientPhone ?? null,
  });

  if (error) {
    /*
     * De cliënt krijgt een algemene melding; het log krijgt de oorzaak.
     *
     * Dit stond er niet, en dat maakte elke storing op productie blind. De action gooit
     * niet maar geeft een foutobject terug, dus er verschijnt geen ERROR in het
     * functielog — alleen een normale invocatie. Wat de bezoeker ziet is "Het gesprek kon
     * niet worden gestart", en dat is één zin voor minstens zes verschillende oorzaken:
     * een signatuur die niet meer klopt (PGRST202), een onbekende organisatie (P0002),
     * ontbrekende toestemming of een ongeldige naam (22023), een rechtenfout (42501), de
     * rate limiter, of een netwerkstoring.
     *
     * Concreet geval waarop dit is gebouwd: de drie migraties van 25 en 26 augustus stonden
     * wel in de repo en niet op productie. De web-app stuurde veertien parameters naar een
     * functie die er elf kende, PostgREST vond geen match, en die melding verdween hier.
     *
     * Geen persoonsgegevens in het log: de naam en de contactgegevens van de cliënt horen
     * niet in een logregel die niemand opruimt. De slug van het kantoor wel — zonder die
     * is een fout niet te plaatsen als er meerdere kantoren draaien.
     */
    console.error('intake: create_public_intake weigerde', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
      org: d.organizationSlug,
    });

    // De rate limiter is de enige fout waar de bezoeker iets aan heeft; de rest zou
    // hooguit verraden hoe het systeem in elkaar zit.
    const teVaak = error.message.includes('te veel intakepogingen');
    return {
      ok: false,
      fout: teVaak
        ? 'Er zijn te veel pogingen vanaf dit adres. Probeer het over een kwartier opnieuw.'
        : 'Het gesprek kon niet worden gestart. Probeer het later opnieuw.',
    };
  }

  const rij = (data as { intake_id: string; organization_id: string }[] | null)?.[0];
  if (!rij) {
    // Geen fout én geen rij: dat hoort niet te kunnen. Een eigen logregel, want deze tak
    // wijst naar iets anders dan de tak hierboven — de functie gaf niets terug in plaats
    // van te weigeren.
    console.error('intake: create_public_intake gaf geen rij terug', {
      org: d.organizationSlug,
    });
    return { ok: false, fout: 'Het gesprek kon niet worden gestart.' };
  }

  /*
   * Het sessietoken wordt hier gemaakt en gaat rechtstreeks naar de worker.
   *
   * Dit is de enige plek met de secret key. De worker mag zijn eigen credential niet kunnen
   * aanmaken of verlengen — wie dat wel kan, heeft er geen aan.
   */
  /*
   * En hier ook vangen, om een andere reden dan hierboven.
   *
   * Deze twee aanroepen gooien in plaats van een foutobject terug te geven. Een throw in
   * een server action is niet blind — Netlify logt hem als ERROR — maar de bezoeker krijgt
   * dan "An unexpected response was received from the server" van de router, in het Engels
   * en zonder enige aanwijzing. Een ontbrekende SUPABASE_SECRET_KEY en een volle
   * sessielimiet zien er voor hem dan hetzelfde uit als een kapotte pagina.
   *
   * De intake die hierboven is aangemaakt blijft staan. Dat is met opzet: er is toestemming
   * gegeven en vastgelegd, en die vastlegging weggooien omdat de sessie daarna niet lukte
   * zou het auditspoor onvollediger maken dan de werkelijkheid.
   */
  let sessie: Awaited<ReturnType<typeof issueAgentSession>>;
  try {
    const service = createServiceRoleClient();
    sessie = await issueAgentSession(service, {
      intakeId: rij.intake_id,
      channel: 'video',
      prewarmedAt: new Date().toISOString(),
    });
  } catch (fout) {
    console.error('intake: sessie uitgeven mislukt', {
      message: fout instanceof Error ? fout.message : String(fout),
      intakeId: rij.intake_id,
      org: d.organizationSlug,
    });
    return { ok: false, fout: 'Het gesprek kon niet worden gestart. Probeer het later opnieuw.' };
  }

  // Hier valt niets meer te weigeren: de basis-URL is bovenaan al ontleed.
  const url = new URL(wsBasis);
  url.searchParams.set('intake', rij.intake_id);
  url.searchParams.set('token', sessie.sessionToken);

  return { ok: true, intakeId: rij.intake_id, wsUrl: url.toString() };
}
