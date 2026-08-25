import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * De publieke gegevens van een kantoor, voor de intakepagina.
 *
 * Via `public_org_by_slug` en niet via een select op `organizations`: die tabel is met RLS
 * afgeschermd en een bezoeker van de intakepagina is niet ingelogd. De RPC geeft precies
 * de velden die publiek mogen zijn — naam, logo, taal en de twee versienummers — en niets
 * over providers, kosten of acceptatiecriteria.
 */

export interface PubliekeOrganisatie {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly logo_url: string | null;
  readonly default_language: 'nl' | 'en';
  readonly privacy_policy_version: string | null;
  readonly ai_disclosure_version: string | null;
}

export async function laadOrganisatie(slug: string): Promise<PubliekeOrganisatie> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('public_org_by_slug', { p_slug: slug });

  const rij = (data as PubliekeOrganisatie[] | null)?.[0];
  // Onbekend, inactief en verwijderd zien er hetzelfde uit. Dat is de bedoeling: of een
  // kantoor bestaat maar geen intakes aanneemt, gaat een willekeurige bezoeker niet aan.
  if (error || !rij) notFound();
  return rij;
}
