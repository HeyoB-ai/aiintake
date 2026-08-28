import { describe, expect, it } from 'vitest';
import { koudeWegRegel, maakKoudeWeg } from './koude-weg';

/**
 * Het afsluiten moet wachten tot het dossier bij is.
 *
 * Aanleiding: na "afsluiten via stopknop" faalde elke schrijfactie met "geen geldig
 * agent-token". Het sessietoken wordt bij `agent_end_session` ingetrokken, en de extractie —
 * een modelaanroep van seconden — liep er gewoon in.
 *
 * Gemeten over 25 beëindigde sessies: nul feiten geschreven ná `ended_at`. De race werd nooit
 * gewonnen.
 */

/** Een klok en een timer die de test zelf bestuurt; anders duurt een timeout-test 15 seconden. */
function harnas() {
  let nu = 0;
  const timers: { fn: () => void; op: number }[] = [];
  return {
    opties: {
      now: () => nu,
      setTimeoutFn: (fn: () => void, ms: number) => {
        timers.push({ fn, op: nu + ms });
        return 0;
      },
    },
    verstrijk(ms: number) {
      nu += ms;
      for (const t of timers.filter((t) => t.op <= nu)) t.fn();
    },
  };
}

const tik = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('wachten op de koude weg', () => {
  it('wacht niet als er niets loopt', async () => {
    // Het normale geval bij een gesprek dat al klaar was. Geen vertraging op het afsluiten.
    const keten = maakKoudeWeg();
    expect(await keten.wacht()).toEqual({ stand: 'niets' });
  });

  it('wacht tot het werk af is voordat de sessie mag sluiten', async () => {
    const h = harnas();
    const keten = maakKoudeWeg(h.opties);

    let klaar = false;
    let laatLos!: () => void;
    keten.volg(
      new Promise<void>((r) => {
        laatLos = () => {
          klaar = true;
          r();
        };
      }),
    );

    let gesloten = false;
    const wachten = keten.wacht(15_000).then(() => {
      gesloten = true;
    });

    await tik();
    // Dit is de kern: zolang de extractie loopt, is er niet afgesloten.
    expect(gesloten, 'de sessie sloot terwijl de koude weg nog liep').toBe(false);

    laatLos();
    await wachten;
    expect(klaar).toBe(true);
    expect(gesloten).toBe(true);
  });

  it('kapt af als het werk blijft hangen, en meldt dat', async () => {
    /*
     * De grens is niet optioneel. Zonder timeout zou `ended_at` op null blijven staan bij een
     * modelaanroep die niet terugkomt — en een sessie die nooit eindigt, blijft de
     * gelijktijdigheidslimiet van het kantoor vullen. Dat legde de dienst eerder plat.
     */
    const h = harnas();
    const keten = maakKoudeWeg(h.opties);
    keten.volg(new Promise<void>(() => undefined)); // komt nooit terug

    const wachten = keten.wacht(15_000);
    await tik();
    h.verstrijk(15_000);

    const uitkomst = await wachten;
    expect(uitkomst.stand).toBe('afgekapt');
    expect(koudeWegRegel(uitkomst)).toContain('NIET AF');
  });

  it('laat één mislukte extractie het afsluiten niet ophouden', async () => {
    // Zou een afwijzing doorlopen, dan valt de hele keten om en blijft ended_at op null.
    const keten = maakKoudeWeg();
    keten.volg(Promise.reject(new Error('extractie stuk')));
    keten.volg(Promise.resolve('en deze lukte wel'));

    const uitkomst = await keten.wacht(1_000);
    expect(uitkomst.stand).toBe('af');
  });

  it('wacht op werk dat pas na het eerste stuk wordt geregistreerd', async () => {
    // De laatste beurt registreert zijn extractie vlak voordat het afsluiten begint; die mag
    // niet buiten de boot vallen omdat de keten al bestond.
    const keten = maakKoudeWeg();
    let tweedeKlaar = false;

    keten.volg(Promise.resolve());
    keten.volg(
      new Promise<void>((r) =>
        setTimeout(() => {
          tweedeKlaar = true;
          r();
        }, 5),
      ),
    );

    await keten.wacht(1_000);
    expect(tweedeKlaar).toBe(true);
  });
});

describe('de logregel', () => {
  it('zwijgt als er niets te melden valt', () => {
    // Een regel die bij elke sessie verschijnt, wordt niet meer gelezen.
    expect(koudeWegRegel({ stand: 'niets' })).toBeNull();
    expect(koudeWegRegel({ stand: 'af', duurMs: 3 })).toBeNull();
  });

  it('meldt een wachttijd die de moeite waard is', () => {
    expect(koudeWegRegel({ stand: 'af', duurMs: 2400 })).toContain('2400 ms');
  });

  it('is luid als er feiten verloren gaan', () => {
    // Stil afkappen zou hetzelfde verlies opleveren als hiervoor, alleen zonder melding.
    const regel = koudeWegRegel({ stand: 'afgekapt', duurMs: 15_000 });
    expect(regel).toContain('Feiten uit de laatste beurten ontbreken');
  });
});
