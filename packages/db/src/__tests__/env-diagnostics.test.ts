import { afterEach, describe, expect, it } from 'vitest';
import { explainMissingTestEnv, readTestEnv } from './harness';

/**
 * De skip-melding van de isolatiesuite moet uitleggen waaróm er wordt overgeslagen.
 *
 * Aanleiding: "geen SUPABASE_TEST_* env gevonden" terwijl de sleutels gewoon in `.env`
 * stonden. De melding stuurde daarmee de verkeerde kant op — het lag aan het inlezen,
 * niet aan de waarden. Deze test legt vast dat dat onderscheid zichtbaar blijft.
 *
 * Raakt geen database aan.
 */

const VARS = [
  'SUPABASE_TEST_URL',
  'SUPABASE_TEST_PUBLISHABLE_KEY',
  'SUPABASE_TEST_SECRET_KEY',
] as const;

const original = new Map<string, string | undefined>(
  [...VARS, 'INTAKE_ENV_FILES_LOADED'].map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const [name, value] of original) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function setOnly(present: readonly string[], filesLoaded?: string) {
  for (const name of VARS) {
    if (present.includes(name)) process.env[name] = 'x'.repeat(20);
    else delete process.env[name];
  }
  if (filesLoaded === undefined) delete process.env['INTAKE_ENV_FILES_LOADED'];
  else process.env['INTAKE_ENV_FILES_LOADED'] = filesLoaded;
}

describe('diagnose bij ontbrekende testconfiguratie', () => {
  it('noemt precies de variabele die mist, en die niet missen', () => {
    setOnly(['SUPABASE_TEST_URL', 'SUPABASE_TEST_PUBLISHABLE_KEY'], '/repo/.env');
    const message = explainMissingTestEnv();

    expect(message).toContain('Ontbreekt: SUPABASE_TEST_SECRET_KEY');
    expect(message).toContain('Wel gevonden: SUPABASE_TEST_URL, SUPABASE_TEST_PUBLISHABLE_KEY');
  });

  it('meldt welk env-bestand is gelezen, zodat je weet dat het niet aan het inlezen ligt', () => {
    setOnly(['SUPABASE_TEST_URL'], '/repo/.env');
    expect(explainMissingTestEnv()).toContain('Gelezen env-bestanden: /repo/.env');
  });

  it('wijst naar de setup-config als er helemaal geen bestand is gelezen', () => {
    // Dit was het oorspronkelijke geval: sleutels stonden in .env, maar vitest laadde
    // dat bestand niet, dus zag de suite niets.
    setOnly([], undefined);
    const message = explainMissingTestEnv();

    expect(message).toContain('Geen van de drie gevonden');
    expect(message).toContain('geen .env-bestand gelezen');
    expect(message).toContain('vitest.config.ts');
  });

  it('readTestEnv weigert een halve configuratie', () => {
    setOnly(['SUPABASE_TEST_URL', 'SUPABASE_TEST_SECRET_KEY'], '/repo/.env');
    expect(readTestEnv()).toBeNull();
  });

  it('readTestEnv accepteert de volledige set', () => {
    setOnly([...VARS], '/repo/.env');
    expect(readTestEnv()).not.toBeNull();
  });
});
