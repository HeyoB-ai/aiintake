import { describe, expect, it } from 'vitest';
import { magAfsluitenWegensStilte, resterendMs, type InactiviteitStand } from './inactiviteit';

/**
 * De regel die een gesprek kan afbreken.
 *
 * Hij is één keer te vroeg afgegaan — de klok liep vanaf het openen van de WebSocket, dus
 * vóór het gesprek — en dat is de ergste fout die deze code kan maken. Daarom staat de
 * beslissing hier los van elke sessie, en staan de grenzen hieronder vast.
 */

const LIMIET = 90_000;
const RESPIJT = 30_000;

const stand = (p: Partial<InactiviteitStand>): InactiviteitStand => ({
  nu: 0,
  gesprekBegonOp: null,
  laatsteActiviteitOp: null,
  limietMs: LIMIET,
  respijtMs: RESPIJT,
  ...p,
});

describe('inactiviteit', () => {
  it('loopt niet zolang het gesprek niet is begonnen', () => {
    // De keten opzetten duurt seconden, en de avatar nog langer. In die tijd is stilte
    // geen signaal. Dít ging mis: de klok begon bij het openen van de socket.
    const s = stand({ nu: 10 * 60_000, gesprekBegonOp: null });
    expect(resterendMs(s)).toBeNull();
    expect(magAfsluitenWegensStilte(s)).toBe(false);
  });

  it('loopt de eerste 30 seconden na de start helemaal niet', () => {
    // De openingsbeurt duurt al zo'n vijftien seconden, en daarna mag iemand nadenken.
    //
    // `resterendMs` telt in die periode af van respijt+limiet naar limiet. Dat is de
    // bedoeling: het is "tijd tot sluiten", niet "tijd sinds de klok loopt", en zo kan de
    // HUD er één getal van maken dat altijd klopt.
    for (const t of [0, 1_000, 15_000, 29_999]) {
      const s = stand({ nu: t, gesprekBegonOp: 0 });
      expect(resterendMs(s)).toBe(RESPIJT + LIMIET - t);
      expect(magAfsluitenWegensStilte(s)).toBe(false);
    }
  });

  it('sluit pas na respijt plus limiet als er nooit iets gezegd is', () => {
    const s = (nu: number): InactiviteitStand => stand({ nu, gesprekBegonOp: 0 });
    expect(magAfsluitenWegensStilte(s(RESPIJT + LIMIET - 1))).toBe(false);
    expect(magAfsluitenWegensStilte(s(RESPIJT + LIMIET))).toBe(true);
  });

  it('telt vanaf de laatste spraak zodra die later valt dan het respijt', () => {
    const gesproken = 100_000;
    const s = (nu: number): InactiviteitStand =>
      stand({ nu, gesprekBegonOp: 0, laatsteActiviteitOp: gesproken });
    expect(magAfsluitenWegensStilte(s(gesproken + LIMIET - 1))).toBe(false);
    expect(magAfsluitenWegensStilte(s(gesproken + LIMIET))).toBe(true);
  });

  it('laat spraak binnen het respijt de klok niet vervroegen', () => {
    // Iemand die meteen iets zegt mag daar niet door benadeeld worden: het respijt is een
    // ondergrens, geen alternatief startpunt.
    const s = stand({ nu: RESPIJT + LIMIET - 1, gesprekBegonOp: 0, laatsteActiviteitOp: 2_000 });
    expect(magAfsluitenWegensStilte(s)).toBe(false);
  });

  it('geeft resterende tijd terug die aftelt en niet negatief wordt', () => {
    expect(resterendMs(stand({ nu: RESPIJT, gesprekBegonOp: 0 }))).toBe(LIMIET);
    expect(resterendMs(stand({ nu: RESPIJT + 30_000, gesprekBegonOp: 0 }))).toBe(LIMIET - 30_000);
    expect(resterendMs(stand({ nu: 10 * LIMIET, gesprekBegonOp: 0 }))).toBe(0);
  });

  it('sluit niet in het eerste kwartier als er af en toe iets gezegd wordt', () => {
    // Een echt gesprek met stiltes van een halve minuut hoort gewoon door te lopen.
    let laatste = 0;
    for (let t = 0; t < 15 * 60_000; t += 30_000) {
      laatste = t;
      const s = stand({ nu: t + 29_000, gesprekBegonOp: 0, laatsteActiviteitOp: laatste });
      expect(magAfsluitenWegensStilte(s)).toBe(false);
    }
  });
});
