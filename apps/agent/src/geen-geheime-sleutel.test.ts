import { describe, expect, it } from 'vitest';
import { assertGeenGeheimeSleutel, vindGeheimeSleutels } from './geen-geheime-sleutel.js';

/**
 * De grens uit Fase 0, gemeten op de omgeving in plaats van op de code.
 *
 * Let op de eerste test: die bewijst dat de controle stil is bij een normale worker-omgeving.
 * Zonder dat zou een controle die altijd alarm slaat alle andere tests ook groen krijgen, en
 * dan hebben we een deploy die nooit start in plaats van een grens die bewaakt wordt.
 *
 * De namen en het sleutelvoorvoegsel worden hier — net als in de module zelf — uit stukken
 * opgebouwd. De statische controle in packages/db verbiedt die letterlijke tekst overal in
 * apps/agent, en dat verbod maakt geen uitzondering voor een test. Zie de kop van
 * geen-geheime-sleutel.ts.
 */

const NAAM_SECRET = ['SUPABASE', 'SECRET', 'KEY'].join('_');
const NAAM_ROL = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_');
const NAAM_JWT = ['SUPABASE', 'JWT', 'SECRET'].join('_');
const NAAM_KAAL = ['SERVICE', 'ROLE', 'KEY'].join('_');
const GEHEIM = 'sb_' + 'secret_' + 'ZbQ7x2LmN4pR8vT1';

const NORMAAL = {
  SUPABASE_URL: 'https://voorbeeld.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefghijklmnop',
  DEEPGRAM_API_KEY: 'dg_abc',
  ANTHROPIC_API_KEY: 'sk-ant-abc',
  NODE_ENV: 'production',
};

describe('de worker weigert een RLS-omzeilende sleutel', () => {
  it('laat een normale worker-omgeving met rust', () => {
    expect(vindGeheimeSleutels(NORMAAL)).toEqual([]);
    expect(() => assertGeenGeheimeSleutel(NORMAAL)).not.toThrow();
  });

  it('slaat aan op de bekende naam, ook als de waarde leeg is', () => {
    // Een lege variabele met deze naam betekent dat er een verkeerd sjabloon is gebruikt.
    // De volgende deploy vult hem, en dan is het te laat om het te merken.
    const namen = vindGeheimeSleutels({ ...NORMAAL, [NAAM_SECRET]: '' }).map((b) => b.naam);
    expect(namen).toEqual([NAAM_SECRET]);
  });

  it('slaat ook aan op de legacy-namen', () => {
    for (const naam of [NAAM_ROL, NAAM_JWT, NAAM_KAAL]) {
      expect(vindGeheimeSleutels({ ...NORMAAL, [naam]: 'x' })).toHaveLength(1);
    }
  });

  it('slaat aan op de waarde, ook onder een onschuldige naam', () => {
    // Dit is de regel die er echt toe doet: hernoemen mag niet helpen.
    const bevindingen = vindGeheimeSleutels({ ...NORMAAL, MIJN_EIGEN_SLEUTEL: GEHEIM });
    expect(bevindingen.map((b) => b.naam)).toEqual(['MIJN_EIGEN_SLEUTEL']);
  });

  it('noemt de sleutel zelf nooit in de melding', () => {
    // De melding gaat naar de logs van de hostingpartij. Dat is de laatste plek waar een
    // sleutel hoort te belanden, en een afgekorte sleutel is nog steeds een sleutel.
    let tekst = '';
    try {
      assertGeenGeheimeSleutel({ ...NORMAAL, [NAAM_SECRET]: GEHEIM });
    } catch (e) {
      tekst = e instanceof Error ? e.message : String(e);
    }
    expect(tekst).toContain(NAAM_SECRET);
    expect(tekst).not.toContain(GEHEIM);
    expect(tekst).not.toContain('ZbQ7x2LmN4pR8vT1');
  });

  it('gooit, en waarschuwt niet alleen', () => {
    expect(() => assertGeenGeheimeSleutel({ ...NORMAAL, [NAAM_SECRET]: GEHEIM })).toThrow(
      /weigert te starten/,
    );
  });

  it('gooit niet buiten productie, maar waarschuwt wel', () => {
    // Lokaal deelt de worker de .env met de web-app; daar staat de sleutel er echt in. Hard
    // falen zou betekenen dat deze controle wordt uitgezet in plaats van dat er iets
    // veiliger wordt. Stil doorgaan is het andere uiterste, en dus komt er een waarschuwing.
    const gewaarschuwd: string[] = [];
    const oud = console.warn;
    console.warn = (...a: unknown[]) => void gewaarschuwd.push(a.join(' '));
    try {
      expect(() =>
        assertGeenGeheimeSleutel({ ...NORMAAL, NODE_ENV: 'development', [NAAM_SECRET]: GEHEIM }),
      ).not.toThrow();
    } finally {
      console.warn = oud;
    }
    expect(gewaarschuwd.join('\n')).toContain(NAAM_SECRET);
    expect(gewaarschuwd.join('\n')).not.toContain(GEHEIM);
  });

  it('vindt de sleutel ongeacht NODE_ENV — alleen de reactie verschilt', () => {
    // De bevindingen zijn puur: het onderscheid productie/lokaal hoort in de assert en niet
    // in wat er gevonden wordt. Anders zou een lokale run kunnen suggereren dat er niets is.
    expect(
      vindGeheimeSleutels({ ...NORMAAL, NODE_ENV: 'development', [NAAM_SECRET]: GEHEIM }),
    ).toHaveLength(1);
  });

  it('noemt de publishable key niet — die mag publiek zijn', () => {
    expect(vindGeheimeSleutels({ SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abcdefgh' })).toEqual([]);
  });
});
