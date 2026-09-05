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
  readonly innerWidth: number;
  readonly visueel: string;
  readonly schaal: string;
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
      /*
       * De berekende stijl erbij, en dat is het verschil tussen "iets is te breed" en "dit is
       * waarom".
       *
       * De eerste meting op het toestel gaf `div.relative.aspect-[3/4]` van [-21..681] — 702
       * breed bij een scherm van rond de 390. En 702 x 4/3 = 936: de hoogte is eerst bepaald en
       * de breedte volgde uit de verhouding, precies andersom dan `w-full` bedoelt. Om dat te
       * bevestigen is nodig wat de browser er zélf van maakt.
       */
      const s = getComputedStyle(el);
      const ouder = el.parentElement;
      buiten.push(
        `${el.tagName.toLowerCase()}${klasse ? '.' + klasse : ''} ` +
          `[${Math.round(r.left)}..${Math.round(r.right)}] ` +
          `w=${s.width} h=${s.height} ar=${s.aspectRatio} ` +
          `ouder=${ouder ? Math.round(ouder.getBoundingClientRect().width) : '-'}`,
      );
    }
  }

  /*
   * Drie breedtes en de zoomfactor, want ze kunnen uit elkaar lopen.
   *
   * Uit de eerste meting op het toestel volgt een rekensom die om deze getallen vraagt. De
   * wrapper heeft `px-4 sm:px-6`; `main` was 750 breed en `section` 702, en dat verschil is 48
   * — twee keer 24, dus `sm:px-6`. Die breakpoint gaat pas open vanaf 640px. Als die klasse
   * werkelijk actief is, denkt de pagina dat hij 750 breed is terwijl het scherm 390 toont, en
   * dan is het probleem niet één te breed element maar de layoutviewport zelf.
   *
   *   clientWidth   wat de CSS als vensterbreedte gebruikt (de layoutviewport)
   *   innerWidth    idem, maar inclusief een eventuele scrollbalk
   *   visualViewport wat er werkelijk te zien is, en de zoomfactor
   *
   * Lopen die uiteen, dan staat Safari ingezoomd of hanteert hij een bredere layoutviewport —
   * en dat is een heel andere reparatie dan een element bijstellen.
   */
  const vv = window.visualViewport;

  return {
    viewport: breedte,
    innerWidth: Math.round(window.innerWidth),
    visueel: vv ? String(Math.round(vv.width)) : '-',
    schaal: vv ? vv.scale.toFixed(2) : '-',
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

  /*
   * Zoom ongelijk aan 1 gaat vóór alles.
   *
   * Dit was de oorzaak, en drie ronden lang keek ik eroverheen. Bij zoom 1.14 stond de layout
   * er goed bij — `main` precies 390 breed, nul overloop, één element buiten beeld — en tóch
   * viel het begin van elke regel weg. Elke meting hieronder gaat over de layout; staat de
   * pagina ingezoomd, dan verklaren die getallen niet wat je ziet.
   *
   * Vandaar een eigen regel bovenaan in plaats van een getal tussen de rest. Wie hem negeert,
   * meet het verkeerde ding.
   */
  const ingezoomd = m.schaal !== '-' && Math.abs(Number(m.schaal) - 1) > 0.01;
  const raak = ingezoomd || m.overloop > 1 || m.buiten.length > 0;

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
      {ingezoomd && (
        <div className="break-all font-bold">
          INGEZOOMD ({m.schaal}×) — de pagina staat gescrold; de getallen hieronder verklaren niet
          wat je ziet. Oorzaak is meestal een invoerveld onder 16px.
        </div>
      )}
      <div className="break-all">
        client {m.viewport} · inner {m.innerWidth} · visueel {m.visueel} · zoom {m.schaal}
      </div>
      <div className="break-all">
        overloop {m.overloop}px · wortel {m.wortelPx} · buiten {m.buiten.length}
      </div>
      {/*
       * Afbreken en niet afkappen.
       *
       * De eerste meting kwam terug met "vw ???" — de regel paste niet en werd onleesbaar. Een
       * meetlint waarvan je de eerste waarde niet kunt lezen, is geen meetlint. `break-all`
       * omdat een klassenaam als `aspect-[3/4]` geen spaties heeft om op af te breken.
       */}
      {m.buiten.slice(0, 3).map((b) => (
        <div key={b} className="break-all">
          {b}
        </div>
      ))}
    </div>
  );
}
