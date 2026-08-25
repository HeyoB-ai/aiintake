import { chromium } from 'playwright';

/**
 * Draait de etalage werkelijk?
 *
 * HTTP 200 op drie bestanden zegt niets over of er iets te zien is. Deze controle laadt de
 * pagina, kijkt of elk component gerenderd is, of Tailwind zijn klassen heeft gevonden en
 * of de themawisselaar de kleuren echt omzet.
 *
 * ## Twee meetvallen die hier al in zijn gelopen
 *
 * 1. **De themaovergang.** Op `body` staat `transition: background-color 0.2s`. Lees je de
 *    berekende kleur meteen na het omzetten van `data-theme`, dan krijg je de waarde
 *    midden in de animatie — en die is nog de oude. Dat zag eruit als "het thema werkt
 *    niet", terwijl `--app-bg` allang was omgezet. Daarom wordt de variabele gelezen én
 *    wordt er op de overgang gewacht.
 *
 * 2. **Drie knoppen met dezelfde tekst.** Er staan drie VideoWindows op de pagina, elk met
 *    "Start gesprek". De eerste is het stand-by-voorbeeld en zijn knop doet met opzet
 *    niets. `.first()` klikte dus op een knop zonder werking. Daarom `[data-blok]` als
 *    haakje: dat verandert niet mee met de tekst.
 *
 * Draaien met: pnpm --filter @intake/ui preview:check  (met de etalage al gestart)
 */

const URL = process.env.PREVIEW_URL ?? 'http://localhost:5180/';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const fouten = [];
page.on('pageerror', (e) => fouten.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error') fouten.push('console: ' + m.text());
});

let mislukt = false;
const eis = (naam, ok, detail = '') => {
  if (!ok) mislukt = true;
  console.log(`  ${ok ? 'ok  ' : 'FOUT'} ${naam}${detail ? ' — ' + detail : ''}`);
};

try {
  await page.goto(URL);
  await page.waitForSelector('[data-blok="video-actief"]', { timeout: 20_000 });

  const tekst = await page.textContent('body');
  eis('Header toont de kantoornaam', tekst.includes('Kantoor De Vries'));
  eis('transcript uit de fixtures', tekst.includes('AI-intake-assistent van Kantoor De Vries'));
  eis('dossier draagt de disclaimer', tekst.includes('menselijke beoordeling vereist'));
  eis('document in verwerking toont geen feiten', tekst.includes('nog geen inhoud beoordeeld'));
  eis('mislukt document noemt de reden', tekst.includes('te onscherp'));

  const radius = await page.evaluate(() => {
    const el = document.querySelector('.rounded-2xl');
    return el ? getComputedStyle(el).borderRadius : null;
  });
  eis(
    'Tailwind heeft de klassen gevonden',
    radius !== null && radius !== '0px',
    `radius ${radius}`,
  );

  // De variabele, niet de geanimeerde eindkleur: zie de kop.
  const kleuren = {};
  for (const thema of ['modern-light', 'sophisticated-dark', 'corporate-navy']) {
    kleuren[thema] = await page.evaluate((t) => {
      document.documentElement.setAttribute('data-theme', t);
      return getComputedStyle(document.documentElement).getPropertyValue('--app-bg').trim();
    }, thema);
  }
  const uniek = new Set(Object.values(kleuren));
  eis('elk thema geeft een eigen achtergrond', uniek.size === 3, JSON.stringify(kleuren));

  // En daarna alsnog het echte gevolg, mét wachttijd voor de overgang.
  await page.waitForTimeout(400);
  const bodyKleur = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  eis('de pagina volgt het thema', bodyKleur === 'rgb(9, 13, 22)', bodyKleur);

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'modern-light'));
  await page.locator('header button').filter({ hasText: 'Helder Zakelijk' }).first().click();
  await page.waitForTimeout(200);
  eis("de kiezer toont vier thema's", (await page.locator('[role="option"]').count()) === 4);
  await page.locator('[role="option"]').filter({ hasText: 'Obsidiaan' }).click();
  await page.waitForTimeout(300);
  const gekozen = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  eis('de kiezer zet het thema om', gekozen === 'sophisticated-dark', String(gekozen));

  // Het tweede blok: dáár doet de knop iets.
  await page
    .locator('[data-blok="video-actief"] button')
    .filter({ hasText: 'Start gesprek' })
    .click();
  await page.waitForTimeout(1500);
  const video = await page.evaluate(() => {
    const v = document.querySelector('[data-blok="video-actief"] video');
    return v
      ? { w: v.videoWidth, h: v.videoHeight, paused: v.paused, opacity: v.style.opacity }
      : null;
  });
  eis(
    'het videovenster toont werkelijk beeld',
    video !== null && video.w > 0 && !video.paused && video.opacity !== '0',
    JSON.stringify(video),
  );

  await page.locator('[data-blok="modaal"] button').click();
  await page.waitForSelector('[role="dialog"]');
  await page.locator('[role="tab"]').filter({ hasText: 'Geëxtraheerde feiten' }).click();
  const modaal = await page.textContent('[role="dialog"]');
  eis('het modaal toont de herkomst van een feit', modaal.includes('bron: pagina 1, regel 3'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  eis('Escape sluit het modaal', (await page.locator('[role="dialog"]').count()) === 0);

  eis('geen paginafouten', fouten.length === 0, fouten.slice(0, 2).join(' | '));
} catch (error) {
  eis('de controle zelf', false, String(error).slice(0, 200));
} finally {
  await browser.close();
}

console.log(mislukt ? '\n  ETALAGE NIET IN ORDE\n' : '\n  de etalage werkt\n');
process.exit(mislukt ? 1 : 0);
