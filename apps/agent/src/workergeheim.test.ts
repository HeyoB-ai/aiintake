import { describe, expect, it } from 'vitest';
import type { AppClient } from '@intake/db-core';
import {
  WORKERGEHEIM_ENV,
  controleerWorkergeheim,
  leesWorkergeheim,
  moetWeigeren,
  workergeheimBanner,
} from './workergeheim';

/**
 * De tweede factor, en vooral: wat de worker doet als hij niet klopt.
 *
 * Zie RISICOS.md risico 31. Het gevaarlijke geval is niet "geen geheim" — dat is de normale
 * stand tussen de twee migraties in — maar "een geheim dat de database niet kent". Dan ziet
 * alles er goed uit, accepteert de worker verbindingen, en faalt straks elke feitschrijving
 * met een melding die naar het sessietoken wijst.
 */

function nepClient(antwoord: { data?: unknown; error?: { message: string } }): AppClient {
  return { rpc: async () => antwoord } as unknown as AppClient;
}

describe('het geheim uit de omgeving lezen', () => {
  it('geeft undefined als hij ontbreekt of leeg is', () => {
    // Railway laat een variabele leeg achter als je hem wist in plaats van verwijdert. Een
    // lege string als geheim meesturen zou een header opleveren die gegarandeerd niet klopt.
    expect(leesWorkergeheim({})).toBeUndefined();
    expect(leesWorkergeheim({ [WORKERGEHEIM_ENV]: '' })).toBeUndefined();
    expect(leesWorkergeheim({ [WORKERGEHEIM_ENV]: '   ' })).toBeUndefined();
  });

  it('leest hem en haalt er witruimte af', () => {
    expect(leesWorkergeheim({ [WORKERGEHEIM_ENV]: '  abc  ' })).toBe('abc');
  });
});

describe('de vier standen', () => {
  it('herkend als de database ja zegt', async () => {
    expect(await controleerWorkergeheim(nepClient({ data: true }), 'g')).toEqual({
      stand: 'herkend',
    });
  });

  it('niet-herkend als de database nee zegt', async () => {
    expect(await controleerWorkergeheim(nepClient({ data: false }), 'g')).toEqual({
      stand: 'niet-herkend',
    });
  });

  it('niet-gezet zonder geheim, zonder de database te vragen', async () => {
    /*
     * De vraag stellen zou hier misleidend zijn: zonder header antwoordt de database altijd
     * nee, en dat zou als "niet-herkend" binnenkomen — de stand waarop de worker weigert te
     * starten. Dan zou een worker die het geheim nog niet heeft, niet meer opkomen.
     */
    const client = {
      rpc: () => {
        throw new Error('niet aanroepen');
      },
    } as unknown as AppClient;
    expect(await controleerWorkergeheim(client, undefined)).toEqual({ stand: 'niet-gezet' });
  });

  it('onbereikbaar als de functie nog niet bestaat', async () => {
    // Tussen het uitrollen van de worker en het pushen van migratie 20260828120000 in.
    const uit = await controleerWorkergeheim(
      nepClient({ error: { message: 'Could not find the function' } }),
      'g',
    );
    expect(uit.stand).toBe('onbereikbaar');
  });
});

describe('wanneer de worker weigert te starten', () => {
  it('weigert bij een geheim dat de database niet kent, in productie', () => {
    /*
     * Dit is de enige stand waarin alles er goed uitziet en niets werkt. Doorstarten betekent
     * gesprekken voeren die niet in het dossier belanden, en dat is erger dan niet starten.
     */
    expect(moetWeigeren({ stand: 'niet-herkend' }, { NODE_ENV: 'production' })).toBe(true);
  });

  it('weigert niet als het geheim er nog niet is', () => {
    // De normale stand tussen de twee migraties in. De banner zegt het luid; weigeren zou
    // betekenen dat de worker tijdens het uitrollen niet meer opkomt.
    expect(moetWeigeren({ stand: 'niet-gezet' }, { NODE_ENV: 'production' })).toBe(false);
  });

  it('weigert niet op een netwerkstoring', () => {
    // Dat zegt niets over het geheim; er een harde storing van maken is de verkeerde ruil.
    expect(
      moetWeigeren({ stand: 'onbereikbaar', fout: 'ETIMEDOUT' }, { NODE_ENV: 'production' }),
    ).toBe(false);
  });

  it('weigert niet buiten productie', () => {
    // Lokaal draait het harnas zonder geheim tegen een database die er wél een kent.
    expect(moetWeigeren({ stand: 'niet-herkend' }, { NODE_ENV: 'development' })).toBe(false);
  });
});

describe('de banner', () => {
  it('meldt ook als alles goed is', () => {
    /*
     * Een controle die alleen praat als er iets mis is, is niet te onderscheiden van een
     * controle die niet draait — en dat is precies hoe risico 31 zo lang onzichtbaar bleef.
     */
    expect(workergeheimBanner({ stand: 'herkend' })).toContain('herkend');
  });

  it('noemt het geheim nooit', () => {
    const regels = [
      workergeheimBanner({ stand: 'herkend' }),
      workergeheimBanner({ stand: 'niet-gezet' }),
      workergeheimBanner({ stand: 'niet-herkend' }),
      workergeheimBanner({ stand: 'onbereikbaar', fout: 'ETIMEDOUT' }),
    ].join('\n');
    // Een opstartbanner belandt in een logdienst; dat is de laatste plek voor een geheim.
    expect(regels).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });
});
