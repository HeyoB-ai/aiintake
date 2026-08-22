import { describe, expect, it } from 'vitest';
import { createSessionToken, hashSessionToken } from './agent-token';

/**
 * Deze hash moet exact overeenkomen met `app.hash_session_token()` in migratie 0600
 * (`encode(extensions.digest(token, 'sha256'), 'hex')`). Lopen de twee uit elkaar, dan
 * valideert geen enkel token meer.
 *
 * Dat kan hier niet tegen Postgres worden gecontroleerd — dat doet de isolatietest
 * "mag naar zijn eigen intake schrijven". Wat hier wél kan: vastleggen dat deze kant
 * een standaard SHA-256 in hex produceert, zodat een fout in de codering hier wordt
 * gevangen en niet pas bij de eerste echte sessie.
 */
describe('sessietoken', () => {
  it('hasht volgens standaard SHA-256 in hex', async () => {
    // Bekende vector: sha256("abc").
    expect(await hashSessionToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // En de lege string, want dat is waar padding-fouten zichtbaar worden.
    expect(await hashSessionToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('levert een base64url-token zonder padding of tekens die ontsnapt moeten worden', async () => {
    const { token } = await createSessionToken();
    // 32 bytes base64url = 43 tekens.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('geeft bij elke aanroep een ander token', async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      tokens.add((await createSessionToken()).token);
    }
    expect(tokens.size).toBe(200);
  });

  it('geeft de hash van het token dat het teruggeeft, niet van iets anders', async () => {
    const { token, tokenHash } = await createSessionToken();
    expect(tokenHash).toBe(await hashSessionToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // Het ruwe token en de hash zijn nooit hetzelfde: dat zou betekenen dat er
    // ergens niet gehasht is.
    expect(tokenHash).not.toBe(token);
  });
});
