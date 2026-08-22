import { z } from 'zod';

/**
 * De env van de worker, bewust smal.
 *
 * Dit proces leest opzettelijk een eigen, kleinere envset in plaats van die van de
 * web-app: alles wat hier niet in staat, kan de worker ook niet per ongeluk gaan
 * gebruiken. Er zit geen sleutel in waarmee dit proces bij meer dan één intake kan.
 *
 * De publishable key mag publiek zijn en geeft op zichzelf geen enkel recht. Wat de
 * worker mag, bepaalt het sessietoken dat hij per sessie aangereikt krijgt — hij kan
 * er zelf geen maken.
 */
const AgentEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .min(20)
    .refine((k) => !k.startsWith('sb_secret_'), {
      message: 'dit is een secret key; de worker hoort die niet te hebben',
    }),

  LIVEKIT_URL: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  DEEPGRAM_API_KEY: z.string().min(1).optional(),
  CARTESIA_API_KEY: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  AVATAR_PROVIDER: z.enum(['beyondpresence', 'anam', 'null']).default('null'),
  BEY_API_KEY: z.string().optional(),
  BEY_AVATAR_ID: z.string().optional(),
  ANAM_API_KEY: z.string().optional(),
  ANAM_AVATAR_ID: z.string().optional(),

  LLM_HOT_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  LLM_COLD_MODEL: z.string().default('claude-sonnet-5'),

  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type AgentEnv = z.infer<typeof AgentEnvSchema>;

export function readAgentEnv(source: NodeJS.ProcessEnv = process.env): AgentEnv {
  const parsed = AgentEnvSchema.safeParse(source);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`agent-env onvolledig: ${missing}`);
  }
  return parsed.data;
}

/** De HUD hoort niet in productie; hier staat die regel op één plek. */
export function hudEnabled(env: AgentEnv): boolean {
  return env.NODE_ENV !== 'production';
}
