import type { Metadata } from 'next';
import { laadOrganisatie } from './org';
import { IntakeFlow } from './intake-flow';

/**
 * De publieke intakepagina van een kantoor.
 *
 * Drie schermen achter elkaar: welkom, toestemming, gesprek. Ze zitten in één route en
 * niet in drie, omdat de toestand ertussen — de microfoonstroom, het gebruikersgebaar dat
 * hem opende — een navigatie niet overleeft. Op iOS is dat geen detail maar de reden dat
 * het werkt: `getUserMedia` en het starten van een `AudioContext` moeten binnen hetzelfde
 * gebaar vallen, en een paginawissel breekt dat.
 *
 * De server doet hier weinig: alleen de publieke kantoorgegevens ophalen. Alles daarna
 * gebeurt in de browser, want daar zit de microfoon.
 */

export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}): Promise<Metadata> {
  const { organizationSlug } = await params;
  const org = await laadOrganisatie(organizationSlug);
  return {
    title: `Intake — ${org.name}`,
    // Een intakepagina hoort niet in een zoekmachine: hij is bedoeld voor iemand die de
    // link van het kantoor heeft gekregen.
    robots: { index: false, follow: false },
  };
}

export default async function IntakePagina({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const org = await laadOrganisatie(organizationSlug);

  return (
    <IntakeFlow
      organizationSlug={org.slug}
      organisatieNaam={org.name}
      logoUrl={org.logo_url}
      privacyVersie={org.privacy_policy_version ?? '1.0'}
      aiVersie={org.ai_disclosure_version ?? '1.0'}
    />
  );
}
