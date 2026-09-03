'use client';

import { useEffect, useState } from 'react';

/**
 * Een meetlint op het toestel zelf.
 *
 * ## Waarom dit bestaat
 *
 * Drie keer is er op een iPhone iets gevonden dat elke poort hier groen liet. De laatste keer
 * schoof de hele pagina zijwaarts weg — overloop op documentniveau — en geen enkele meting kon
 * dat reproduceren:
 *
 *   Chromium op 390px    bereikt het gespreksscherm, maar is Safari niet.
 *   WebKit (Playwright)  ís Safari's motor, maar deze build heeft geen `AudioContext` en geen
 *                        `canvas.captureStream`. Zonder die twee is er geen MediaStream te
 *                        maken, blijft de microfoonpoort dicht en wordt het gespreksscherm
 *                        nooit bereikt. Gemeten, niet vermoed.
 *
 * Daarmee houdt het simuleren op. Wat overblijft is meten op het toestel waar de fout zich
 * voordoet — en dan moeten de getallen van dat toestel af te lezen zijn, want iOS Safari heeft
 * geen console zonder een Mac ernaast.
 *
 * ## Waarom dit nooit in productie staat
 *
 * `process.env.NODE_ENV` wordt door de bundler vervangen door een letterlijke waarde, dus in
 * een productiebuild valt deze component weg bij het samenstellen — hij komt niet in de bundel
 * die een cliënt binnenhaalt. Dat is opzet: dit is gereedschap voor de ontwikkelaar en niets
 * voor iemand die net is ontslagen.
 *
 * Gebruik: `pnpm dev:https`, dan het LAN-adres openen op de telefoon.
 */

interface Meting {
  readonly viewport: number;
  readonly overloop: number;
  readonly wortelPx: string;
  readonly buiten: readonly string[];
}

function meet(): Meting {
  const doc = document.documentElement;
  const breedte = doc.clientWidth;
  const buiten: string[] = [];

  for (const el of document.querySelectorAll('body *')) {
    // Het meetlint meet zichzelf niet.
    if (el.closest('[data-meetlint]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > breedte + 0.5 || r.left < -0.5) {
      const klasse = (el.className?.toString?.() ?? '').split(' ').slice(0, 2).join('.');
      buiten.push(
        `${el.tagName.toLowerCase()}${klasse ? '.' + klasse : ''} ` +
          `[${Math.round(r.left)}..${Math.round(r.right)}]`,
      );
    }
  }

  return {
    viewport: breedte,
    overloop: doc.scrollWidth - doc.clientWidth,
    wortelPx: getComputedStyle(doc).fontSize,
    buiten,
  };
}

export function Meetlint() {
  const [m, setM] = useState<Meting | null>(null);

  useEffect(() => {
    /*
     * Herhaald meten en niet één keer.
     *
     * De elementen die misgaan — de vraag, de voortgang, het transcript — verschijnen pas als
     * er een gesprek loopt. Een meting bij het laden zou dus precies het lege scherm zien, en
     * dat is de fout die de vorige ronde groen maakte.
     */
    const tik = () => setM(meet());
    tik();
    const timer = setInterval(tik, 1000);
    window.addEventListener('resize', tik);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', tik);
    };
  }, []);

  if (!m) return null;

  const raak = m.overloop > 1 || m.buiten.length > 0;

  return (
    <div
      data-meetlint
      /*
       * `fixed` met `inset-x-0`: dit vak kan zelf geen overloop veroorzaken, en dat is hier
       * geen detail — een meetlint dat de gemeten waarde beïnvloedt, meet niets.
       */
      className="fixed inset-x-0 bottom-0 z-50 px-2 py-1 font-mono text-[10px] leading-tight"
      style={{
        backgroundColor: raak ? 'var(--urgency-critical-bg)' : 'var(--app-card)',
        color: 'var(--app-text)',
        borderTop: '1px solid var(--app-border)',
      }}
    >
      <div>
        vw {m.viewport} · overloop {m.overloop}px · wortel {m.wortelPx} · buiten {m.buiten.length}
      </div>
      {m.buiten.slice(0, 3).map((b) => (
        <div key={b} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {b}
        </div>
      ))}
    </div>
  );
}
