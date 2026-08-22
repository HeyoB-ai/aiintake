import { redirect } from 'next/navigation';
import { ROLE_RANK, type Role } from '@intake/domain';
import { createClient } from './supabase/server';

/**
 * Rolafhandeling voor het dashboard.
 *
 * De autorisatiebeslissing valt uiteindelijk in de database — RLS is de grens die
 * telt. Deze laag bepaalt alleen wat we tónen: een knop verbergen die toch zou falen
 * is beleefdheid, geen beveiliging. Daarom staat er nergens een check die de UI
 * toegang geeft die RLS zou weigeren, alleen andersom.
 */

export interface Membership {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: Role;
}

export interface CurrentUser {
  id: string;
  email: string;
  fullName: string | null;
  memberships: Membership[];
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from('organization_users')
    .select('role, organizations(id, name, slug)')
    .is('deleted_at', null);

  if (error) {
    // Geen throw: een gebruiker zonder leesbaar lidmaatschap hoort een lege staat te
    // zien, geen stacktrace.
    return {
      id: user.id,
      email: user.email ?? '',
      fullName: (user.user_metadata?.['full_name'] as string | undefined) ?? null,
      memberships: [],
    };
  }

  const memberships: Membership[] = (data ?? []).flatMap((row: any) => {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    if (!org) return [];
    return [
      {
        organizationId: org.id as string,
        organizationName: org.name as string,
        organizationSlug: org.slug as string,
        role: row.role as Role,
      },
    ];
  });

  return {
    id: user.id,
    email: user.email ?? '',
    fullName: (user.user_metadata?.['full_name'] as string | undefined) ?? null,
    memberships,
  };
}

export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/** De actieve organisatie: uit de URL of anders de eerste waar de gebruiker lid van is. */
export function resolveMembership(user: CurrentUser, organizationId?: string): Membership | null {
  if (organizationId) {
    return user.memberships.find((m) => m.organizationId === organizationId) ?? null;
  }
  return user.memberships[0] ?? null;
}

export function hasRole(membership: Membership | null, minimum: Role): boolean {
  if (!membership) return false;
  return ROLE_RANK[membership.role] >= ROLE_RANK[minimum];
}
