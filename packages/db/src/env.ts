import { z } from 'zod';

/**
 * Envvalidatie faalt hard bij het opstarten, niet halverwege een intake.
 *
 * De splitsing tussen `publicEnv` en `serverEnv` is opzettelijk streng: alles in
 * `serverEnv` mag nooit in een clientbundle terechtkomen (§2.8). De naamgeving
 * (`NEXT_PUBLIC_`) is daarbij de enige bescherming die de bundler kent, dus de
 * scheiding staat ook hier expliciet in het type.
 */

const PublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
});

const ServerEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  /** Nodig om agent-tokens te ondertekenen. Bestaat NIET in apps/agent. */
  SUPABASE_JWT_SECRET: z.string().min(20),
  /** Pepper voor het hashen van IP-adressen in de rate limiter. */
  INTAKE_IP_HASH_PEPPER: z.string().min(16),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function readPublicEnv(source: Record<string, string | undefined> = process.env): PublicEnv {
  const parsed = PublicEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Ontbrekende publieke env: ${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

export function readServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  const parsed = ServerEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Ontbrekende server-env: ${formatIssues(parsed.error.issues)}`);
  }
  return parsed.data;
}

function formatIssues(issues: readonly z.ZodIssue[]): string {
  return issues.map((i) => i.path.join('.')).join(', ');
}
