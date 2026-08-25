import { z } from 'zod';

/**
 * Envvalidatie faalt hard bij het opstarten, niet halverwege een intake.
 *
 * Dit project gebruikt de nieuwe Supabase API-keys: `sb_publishable_...` mag publiek
 * zijn, `sb_secret_...` niet. De legacy anon/service-role keys en het bijbehorende
 * gedeelde HS256-secret komen hier bewust niet meer voor — die verdwijnen eind 2026,
 * en het HS256-secret was de enige reden dat we ooit zelf een JWT konden ondertekenen.
 * Dat kan nu niet meer, en hoeft ook niet meer: zie
 * docs/ADR-0007-agent-sessietoken.md.
 *
 * De splitsing tussen `publicEnv` en `serverEnv` is opzettelijk streng: alles in
 * `serverEnv` mag nooit in een clientbundle terechtkomen (§2.8).
 */

const PublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .min(20)
    .refine((k) => !k.startsWith('sb_secret_'), {
      message: 'dit is een secret key; die hoort nooit in een NEXT_PUBLIC_-variabele',
    }),
  /**
   * Het adres van de realtime worker.
   *
   * Hier en niet alleen in de code die hem leest, omdat het protocol de helft van de fout
   * is: een `https`-pagina mag geen `ws://` openen. De browser blokkeert dat als gemengde
   * inhoud, zonder fout en zonder event — je ziet alleen een gespreksscherm dat blijft
   * laden. Een schema dat alleen "is het een URL" toetst, laat precies die versie door.
   */
  NEXT_PUBLIC_AGENT_WS_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('ws://') || u.startsWith('wss://'), {
      message: 'moet met ws:// of wss:// beginnen; een http-adres opent geen WebSocket',
    }),
});

const ServerEnvSchema = z.object({
  /**
   * Omzeilt RLS. Alleen in apps/web, nooit in apps/agent — bewaakt door
   * packages/db/src/__tests__/agent-has-no-service-role.test.ts.
   */
  SUPABASE_SECRET_KEY: z.string().min(20),
  /** Pepper voor het hashen van IP-adressen in de rate limiter. */
  INTAKE_IP_HASH_PEPPER: z.string().min(16),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function readPublicEnv(source: Record<string, string | undefined> = process.env): PublicEnv {
  const parsed = PublicEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Ontbrekende of ongeldige publieke env: ${formatIssues(parsed.error.issues)}`);
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
  return issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ');
}
