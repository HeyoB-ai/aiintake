import { describe, expect, it } from 'vitest';
import { assertGeenWorkergeheim, vindWorkergeheim } from './geen-workergeheim';

/**
 * De spiegel van `apps/agent/src/geen-geheime-sleutel.test.ts`.
 *
 * Die bewaakt dat de worker geen RLS-omzeilende sleutel krijgt; deze bewaakt dat de web-app
 * het workergeheim niet krijgt. Samen zijn ze de grens tussen de twee processen, en die grens
 * gaat in één keer weg als iemand een sjabloon volgt dat zegt "kopieer dit blok naar beide".
 */

describe('herkennen', () => {
  it('vindt de variabele onder elk van zijn namen', () => {
    expect(vindWorkergeheim({ AGENT_WORKER_SECRET: 'x' }).map((b) => b.naam)).toEqual([
      'AGENT_WORKER_SECRET',
    ]);
    expect(vindWorkergeheim({ WORKER_SECRET: 'x' })).toHaveLength(1);
    expect(vindWorkergeheim({ AGENT_WORKER_GEHEIM: 'x' })).toHaveLength(1);
  });

  it('vindt hem ook als hij leeg is', () => {
    /*
     * Een lege variabele met die naam betekent dat iemand de verkeerde sjabloon heeft gepakt,
     * en de volgende deploy vult hem. Dezelfde redenering als bij de worker-kant.
     */
    expect(vindWorkergeheim({ AGENT_WORKER_SECRET: '' })).toHaveLength(1);
  });

  it('laat een schone omgeving met rust', () => {
    // Anders bewaakt de rest niets: een controle die overal iets vindt, zou ook slagen.
    expect(
      vindWorkergeheim({ SUPABASE_SECRET_KEY: 'sb_secret_x', NODE_ENV: 'production' }),
    ).toEqual([]);
  });
});

describe('weigeren', () => {
  it('gooit in productie', () => {
    expect(() =>
      assertGeenWorkergeheim({ NODE_ENV: 'production', AGENT_WORKER_SECRET: 'x' }),
    ).toThrow(/weigert te starten/);
  });

  it('noemt het geheim niet in de foutmelding', () => {
    // Een foutmelding belandt in een logdienst. Alleen de naam, nooit de waarde.
    try {
      assertGeenWorkergeheim({ NODE_ENV: 'production', AGENT_WORKER_SECRET: 'geheimewaarde123' });
      expect.unreachable('had moeten gooien');
    } catch (fout) {
      expect(String(fout)).toContain('AGENT_WORKER_SECRET');
      expect(String(fout)).not.toContain('geheimewaarde123');
    }
  });

  it('waarschuwt maar gooit niet buiten productie', () => {
    // Lokaal deelt dit project één .env; hard falen zou betekenen dat de controle wordt
    // uitgezet in plaats van dat er iets veiliger wordt.
    expect(() =>
      assertGeenWorkergeheim({ NODE_ENV: 'development', AGENT_WORKER_SECRET: 'x' }),
    ).not.toThrow();
  });

  it('doet niets bij een schone omgeving', () => {
    expect(() => assertGeenWorkergeheim({ NODE_ENV: 'production' })).not.toThrow();
  });
});
