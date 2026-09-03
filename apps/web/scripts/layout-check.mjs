import { chromium } from 'playwright';

/**
 * Renderen de gedeelde componenten in de échte applicatie zoals ze horen?
 *
 * ## Het gat dat dit dicht
 *
 * Er waren twee controles: `packages/ui/preview/controle.mjs` toetst de etalage, en
 * `apps/agent/live/zichtbaarheid.mjs` toetst de gesprekspagina. Allebei groen, en tóch
 * stond `DossierSidebar` in het advocatendashboard horizontaal — volledigheid, urgentie en
 * feiten naast elkaar, met de feitenkolom buiten de rand.
 *
 * De oorzaak zat niet in de component maar in de inbedding: Tailwind genereert alleen de
 * utilities die het in de gescande bronnen tegenkomt. `apps/web` scande zijn eigen `src`
 * en niet `packages/ui/src`. Klassen die de app zélf óók gebruikt bestonden daardoor
 * (`flex`, `gap-6`, `w-full`), klassen die alleen in de componenten voorkomen niet
 * (`flex-col`, `rounded-2xl`). Gemeten in de geserveerde CSS: `flex-direction: column` kwam
 * nul keer voor, en de zijbalk viel dus terug op de standaardrichting `row`.
 *
 * Dat is het venijnige eraan: geen ontbrekende opmaak, maar verkeerde opmaak. Een
 * component die half zijn klassen krijgt ziet er kapot uit op een manier die niet naar de
 * oorzaak wijst.
 *
 * ## Waarom een aparte controle en niet een uitbreiding van de etalage
 *
 * De etalage kan dit per definitie niet vangen. Daar bestaan de klassen wél, want die
 * pagina bundelt zijn eigen CSS met een `@source` op dezelfde map. Elke controle die in de
 * catalogus draait mist deze fout. Alleen de echte pagina, met de echte stylesheet, kan
 * hem laten zien.
 *
 * Draaien met: pnpm --filter @intake/web layout:check   (met de dev-server erbij)
 */

const BASIS = process.env.WEB_URL ?? 'http://localhost:3100';
const EMAIL = process.env.DEMO_EMAIL ?? 'advocaat@vandijk-arbeidsrecht.test';
const WACHTWOORD = process.env.DEMO_PASSWORD ?? 'Demo-Intake-2026!aA1';

let mislukt = false;
const eis = (naam, ok, detail = '') => {
  if (!ok) mislukt = true;
  console.log(`  ${ok ? 'ok  ' : 'FOUT'} ${naam}${detail ? ' — ' + detail : ''}`);
};

/*
 * Twee vensterbreedtes.
 *
 * De eerste melding hierover kwam van een iPhone: kaarten die over elkaar heen liggen,
 * terwijl het op een desktop klopte. Een controle die alleen op 1500px kijkt, kan dat per
 * definitie niet vinden — en mobile-first betekent dat de smalle kant de maat is.
 */
const BREEDTES = [
  { naam: 'telefoon', width: 390, height: 844 },
  { naam: 'desktop', width: 1500, height: 1000 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: BREEDTES[1] });
const fouten = [];
page.on('pageerror', (e) => fouten.push(e.message));

try {
  await page.goto(`${BASIS}/login`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', WACHTWOORD);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/dashboard', { timeout: 30_000 });

  await page.click('a[href*="/dashboard/intakes/"]');
  await page.waitForURL('**/dashboard/intakes/**', { timeout: 30_000 });
  await page.waitForSelector('aside[aria-label="Dossier"]');

  /*
   * De utilities die alleen in packages/ui voorkomen.
   *
   * Dit is de directe oorzaak en niet het symptoom: ontbreekt er één, dan rendert er
   * ergens een component verkeerd, ook op een plek die deze controle niet bezoekt.
   */
  const ontbrekend = await page.evaluate(() => {
    const proef = document.createElement('div');
    document.body.append(proef);
    const uit = [];
    /*
     * De derde waarde is de STANDAARD, niet de gewenste uitkomst.
     *
     * Blijft de berekende waarde gelijk aan de standaard, dan bestaat de klasse niet en
     * doet hij niets. Hier stond eerst 'column' bij `flex-col` — de gewenste uitkomst dus
     * — en daarmee meldde de probe "ontbreekt" precies wanneer de klasse wél werkte. Dat
     * viel op doordat hij zichzelf tegensprak: dezelfde run zag de zijbalk verticaal
     * stapelen.
     */
    for (const [klasse, eigenschap, standaard] of [
      ['flex-col', 'flexDirection', 'row'],
      ['rounded-2xl', 'borderTopLeftRadius', '0px'],
      ['overflow-y-auto', 'overflowY', 'visible'],
      ['tracking-wider', 'letterSpacing', 'normal'],
    ]) {
      proef.className = klasse;
      if (getComputedStyle(proef)[eigenschap] === standaard) uit.push(klasse);
    }
    proef.remove();
    return uit;
  });
  eis(
    'de utilities uit packages/ui bestaan in de stylesheet van de app',
    ontbrekend.length === 0,
    ontbrekend.length > 0 ? `ontbreekt: ${ontbrekend.join(', ')}` : '',
  );

  const zijbalk = await page.evaluate(() => {
    const el = document.querySelector('aside[aria-label="Dossier"]');
    if (!el) return null;
    const stijl = getComputedStyle(el);
    const rand = el.getBoundingClientRect();
    // Steekt er inhoud buiten de zijbalk uit? Dat is wat "de feitenkolom wordt afgekapt"
    // in meetbare vorm is.
    let overschrijding = 0;
    for (const kind of el.querySelectorAll('*')) {
      const k = kind.getBoundingClientRect();
      overschrijding = Math.max(overschrijding, k.right - rand.right, rand.left - k.left);
    }
    return {
      display: stijl.display,
      richting: stijl.flexDirection,
      breedte: Math.round(rand.width),
      overschrijding: Math.round(overschrijding),
      scrollOverloop: el.scrollWidth - el.clientWidth,
    };
  });

  eis('de dossierzijbalk staat er', zijbalk !== null);
  if (zijbalk) {
    eis(
      'de zijbalk stapelt verticaal',
      zijbalk.display === 'flex' && zijbalk.richting === 'column',
      `${zijbalk.display} / ${zijbalk.richting}`,
    );
    eis(
      'er steekt niets buiten de zijbalk',
      zijbalk.overschrijding <= 1 && zijbalk.scrollOverloop <= 1,
      `${zijbalk.overschrijding}px buiten de rand, ${zijbalk.scrollOverloop}px horizontale overloop`,
    );
    eis(
      'de zijbalk heeft een redelijke breedte',
      zijbalk.breedte >= 300 && zijbalk.breedte <= 520,
      `${zijbalk.breedte}px`,
    );
  }

  // De secties horen ónder elkaar te staan, niet naast elkaar. Dat is de klacht in de
  // meest directe vorm: drie koppen op dezelfde hoogte.
  const koppen = await page.evaluate(() =>
    [...document.querySelectorAll('aside[aria-label="Dossier"] h2')].map((h) => ({
      tekst: (h.textContent ?? '').trim().slice(0, 24),
      top: Math.round(h.getBoundingClientRect().top),
    })),
  );
  const opDezelfdeHoogte = koppen.filter((k, i) =>
    koppen.some((a, j) => j !== i && Math.abs(a.top - k.top) < 8),
  );
  eis(
    'de secties staan onder elkaar',
    koppen.length >= 3 && opDezelfdeHoogte.length === 0,
    opDezelfdeHoogte.map((k) => `${k.tekst}@${k.top}`).join(' | '),
  );

  // De pagina zelf mag niet horizontaal scrollen.
  const paginaOverloop = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  eis('de pagina scrolt niet horizontaal', paginaOverloop <= 1, `${paginaOverloop}px`);

  /*
   * Overlappende kaarten, op beide breedtes.
   *
   * Twee blokken die elkaar in beide richtingen raken, overlappen. Dat is de klacht in
   * meetbare vorm — "de tekst loopt dwars door elkaar" is precies dit.
   */
  for (const maat of BREEDTES) {
    await page.setViewportSize({ width: maat.width, height: maat.height });
    await page.waitForTimeout(400);

    const meting = await page.evaluate(() => {
      const blokken = [...document.querySelectorAll('main > section, aside[aria-label="Dossier"]')];
      const vakken = blokken.map((el) => {
        const r = el.getBoundingClientRect();
        const kop = el.querySelector('h2');
        return {
          naam: (kop?.textContent ?? el.getAttribute('aria-label') ?? '?').trim().slice(0, 24),
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
        };
      });
      const botsingen = [];
      for (let i = 0; i < vakken.length; i += 1) {
        for (let j = i + 1; j < vakken.length; j += 1) {
          const a = vakken[i];
          const b = vakken[j];
          const horizontaal = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const verticaal = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          // Een paar pixels marge: subpixelafronding is geen overlap.
          if (horizontaal > 4 && verticaal > 4) {
            botsingen.push(`${a.naam} × ${b.naam} (${Math.round(verticaal)}px)`);
          }
        }
      }
      return {
        aantal: vakken.length,
        botsingen,
        overloop: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    eis(
      `${maat.naam}: kaarten overlappen niet`,
      meting.botsingen.length === 0,
      meting.botsingen.join(' | '),
    );
    eis(`${maat.naam}: geen horizontale overloop`, meting.overloop <= 1, `${meting.overloop}px`);
    eis(`${maat.naam}: alle blokken staan er`, meting.aantal >= 6, `${meting.aantal} blokken`);

    /*
     * Dozen die begrenzen maar niet knippen — per breedte.
     *
     * Dit is de fóútvorm achter de iPhone-melding, niet het symptoom: een element met een
     * `max-height` en `overflow: visible` waarvan de inhoud hoger is. Zo'n doos bepaalt wél
     * waar het volgende blok begint maar houdt zijn eigen inhoud niet binnen, en dan krijgt
     * wat eronder staat die inhoud er dwars doorheen.
     *
     * Binnen de lus en niet erna, en dat is precies waar de eerste versie van deze controle
     * op faalde: op 1500px paste het transcript nog binnen zijn 640px, op 390px wikkelt
     * dezelfde tekst naar veel meer regels en past hij niet. Een constructiecontrole op één
     * breedte is een controle die de smalle kant niet ziet.
     */
    const lekkendeDozen = await page.evaluate(() => {
      const gevonden = [];
      for (const el of document.querySelectorAll('main *, aside *')) {
        const stijl = getComputedStyle(el);
        if (stijl.maxHeight === 'none') continue;
        if (stijl.overflowY !== 'visible' || stijl.overflowX !== 'visible') continue;
        const grens = Number.parseFloat(stijl.maxHeight);
        if (!Number.isFinite(grens)) continue;
        if (el.scrollHeight > grens + 1) {
          const eersteKlasse = (el.className?.toString?.() ?? '').split(' ')[0];
          gevonden.push(
            `${el.tagName.toLowerCase()}.${eersteKlasse} ` +
              `(inhoud ${el.scrollHeight}px in max-height ${Math.round(grens)}px)`,
          );
        }
      }
      return gevonden;
    });
    eis(
      `${maat.naam}: geen doos die begrenst zonder te knippen`,
      lekkendeDozen.length === 0,
      lekkendeDozen.slice(0, 3).join(' | '),
    );

    /*
     * Dozen die zijwaarts scrollen zonder dat dat de bedoeling is.
     *
     * De paginabrede controle hierboven vindt dit per definitie níét, en dat is gemeten. Een
     * vak met `overflow-y: auto` krijgt van de CSS-spec automatisch `overflow-x: auto` erbij.
     * Loopt de inhoud zijwaarts uit, dan vángt dat vak het op: `documentElement.scrollWidth`
     * blijft gelijk en de pagina meldt nul overloop.
     *
     * Wat de cliënt ziet is iets anders. Het vak staat dan zijwaarts verschoven en het begin
     * van elke regel valt weg — "ASSISTENT" wordt "SSISTENT", "Kunt u" wordt "unt u". Gemeten
     * op een iPhone 14 in WebKit: één URL in het transcript gaf 74px horizontale scroll in een
     * vak van 358px, met de pagina op nul.
     *
     * De oorzaak is bijna altijd dezelfde: een flex-item zonder `min-w-0`. Zo'n item heeft
     * `min-width: auto` en weigert te krimpen onder zijn langste woord.
     */
    const zijwaartseVakken = await page.evaluate(() => {
      const gevonden = [];
      for (const el of document.querySelectorAll('main *, aside *')) {
        const stijl = getComputedStyle(el);
        if (stijl.overflowX === 'visible' || stijl.overflowX === 'hidden') continue;
        // Een pixel marge: subpixelafronding is geen overloop.
        if (el.scrollWidth > el.clientWidth + 1) {
          const eersteKlasse = (el.className?.toString?.() ?? '').split(' ')[0];
          gevonden.push(
            `${el.tagName.toLowerCase()}.${eersteKlasse} ` +
              `(inhoud ${el.scrollWidth}px in ${el.clientWidth}px)`,
          );
        }
      }
      return gevonden;
    });
    eis(
      `${maat.naam}: geen vak dat zijwaarts scrolt`,
      zijwaartseVakken.length === 0,
      zijwaartseVakken.slice(0, 3).join(' | '),
    );
  }

  eis('geen paginafouten', fouten.length === 0, fouten.slice(0, 2).join(' | '));
} catch (error) {
  eis('de controle zelf', false, String(error).slice(0, 200));
} finally {
  await browser.close();
}

console.log(mislukt ? '\n  LAYOUT NIET IN ORDE\n' : '\n  de layout klopt\n');
process.exit(mislukt ? 1 : 0);
