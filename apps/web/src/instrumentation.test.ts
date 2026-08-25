import { afterEach, describe, expect, it } from 'vitest';
import { register } from './instrumentation';

/**
 * De controle die de vorige deploy had moeten vangen.
 *
 * Het punt van deze tests is niet dat zod werkt — dat is elders getest — maar dat `register`
 * daadwerkelijk gooit. De vorige versie van deze grens bestond ook, in `packages/db`, en
 * werd nergens aangeroepen. Een test die alleen het schema toetst zou daar groen op zijn
 * gebleven.
 */

const COMPLEET = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdef',
  NEXT_PUBLIC_AGENT_WS_URL: 'wss://worker.up.railway.app',
  SUPABASE_SECRET_KEY: 'sb_secret_0123456789abcdef',
  INTAKE_IP_HASH_PEPPER: '0123456789abcdef0123',
} as const;

const SLEUTELS = [...Object.keys(COMPLEET), 'NEXT_RUNTIME', 'NEXT_PHASE', 'NODE_ENV'] as const;
const ORIGINEEL = new Map(SLEUTELS.map((k) => [k, process.env[k]]));

function zet(env: Partial<Record<(typeof SLEUTELS)[number], string | undefined>>): void {
  for (const sleutel of SLEUTELS) {
    const waarde = env[sleutel];
    if (waarde === undefined) delete process.env[sleutel];
    else process.env[sleutel] = waarde;
  }
}

afterEach(() => {
  for (const [sleutel, waarde] of ORIGINEEL) {
    if (waarde === undefined) delete process.env[sleutel];
    else process.env[sleutel] = waarde;
  }
});

describe('register', () => {
  it('gooit als de publishable key ontbreekt, met de naam erbij', async () => {
    const { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: _weg, ...rest } = COMPLEET;
    zet({ ...rest, NEXT_RUNTIME: 'nodejs' });

    await expect(register()).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);
  });

  it('gooit als de server-only variabelen ontbreken', async () => {
    const { SUPABASE_SECRET_KEY: _a, INTAKE_IP_HASH_PEPPER: _b, ...rest } = COMPLEET;
    zet({ ...rest, NEXT_RUNTIME: 'nodejs' });

    await expect(register()).rejects.toThrow(/SUPABASE_SECRET_KEY.*INTAKE_IP_HASH_PEPPER/s);
  });

  it('noemt alle ontbrekende variabelen in één melding', async () => {
    zet({ NEXT_PUBLIC_SUPABASE_URL: COMPLEET.NEXT_PUBLIC_SUPABASE_URL, NEXT_RUNTIME: 'nodejs' });

    // Precies de stand op Netlify: alleen de URL was gezet. Wie dit één variabele per
    // deploy moet ontdekken, is vier deploys verder.
    const fout = await register().catch((f: unknown) => f);
    expect(String(fout)).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    expect(String(fout)).toContain('NEXT_PUBLIC_AGENT_WS_URL');
    expect(String(fout)).toContain('SUPABASE_SECRET_KEY');
    expect(String(fout)).toContain('INTAKE_IP_HASH_PEPPER');
  });

  it('weigert een ws-adres op productie', async () => {
    // NODE_ENV is in de testomgeving 'test'; de regel geldt alleen op productie. Zetten gaat
    // via `zet`, want Next declareert `process.env.NODE_ENV` als readonly.
    zet({
      ...COMPLEET,
      NEXT_PUBLIC_AGENT_WS_URL: 'ws://worker.test',
      NEXT_RUNTIME: 'nodejs',
      NODE_ENV: 'production',
    });

    await expect(register()).rejects.toThrow(/gemengde inhoud/);
  });

  it('laat een complete omgeving door', async () => {
    zet({ ...COMPLEET, NEXT_RUNTIME: 'nodejs' });

    await expect(register()).resolves.toBeUndefined();
  });

  it('doet niets tijdens de build, want daar horen de geheimen niet te zijn', async () => {
    zet({ NEXT_RUNTIME: 'nodejs', NEXT_PHASE: 'phase-production-build' });

    await expect(register()).resolves.toBeUndefined();
  });

  it('doet niets in de edge-runtime, die de server-only variabelen niet kent', async () => {
    zet({ NEXT_RUNTIME: 'edge' });

    await expect(register()).resolves.toBeUndefined();
  });
});
