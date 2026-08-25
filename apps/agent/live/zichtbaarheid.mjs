import { chromium } from 'playwright';

/**
 * Is het gezicht daadwerkelijk te zíen?
 *
 * Een eerdere controle keek naar `videoWidth`/`videoHeight` en zag 1152×768. Dat leest de
 * stream uit en zegt niets over het scherm: een element met `display:none` of nul hoogte
 * rapporteert precies dezelfde afmetingen. Die test bewees dus iets anders dan hij leek.
 *
 * Deze kijkt naar wat er staat:
 *
 *   - `getBoundingClientRect()` — heeft het element oppervlak op de pagina;
 *   - `checkVisibility()` — is het niet verborgen door display, visibility of opacity;
 *   - een schermafdruk van het element — staan er werkelijk pixels, en zijn die niet
 *     allemaal dezelfde kleur (een zwart vlak is geen gezicht).
 *
 * En hij draait **zonder** `--autoplay-policy=no-user-gesture-required`. Die vlag stond in
 * de vorige controle en zet precies de regel uit die in een echte browser het probleem
 * kan zijn. Een test die de omstandigheid wegneemt die je onderzoekt, kan niet falen om
 * de goede reden.
 *
 * Draaien met: pnpm --filter @intake/agent zichtbaarheid
 * (met dev:live al gestart, met AVATAR_PROVIDER=anam)
 */

const URL = process.env.LIVE_URL ?? 'http://localhost:5174/';

const browser = await chromium.launch({
  // Wél een neppe microfoon, want daar gaat deze test niet over; géén autoplay-vlag.
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

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
  await page.click('#start');
  await page.waitForTimeout(18_000);

  const st = await page.evaluate(() => {
    const v = document.getElementById('avatar');
    const r = v.getBoundingClientRect();
    const cs = getComputedStyle(v);
    return {
      w: Math.round(r.width),
      h: Math.round(r.height),
      binnenViewport: r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0,
      zichtbaar: v.checkVisibility?.() ?? cs.display !== 'none',
      display: cs.display,
      paused: v.paused,
      readyState: v.readyState,
      fasen: [...document.querySelectorAll('.stap')].map(
        (e) => `${e.dataset.stap}:${e.className.replace('stap', '').trim() || '-'}`,
      ),
      fasefout: document.getElementById('fasefout').textContent,
      build: document.getElementById('build').textContent,
      // Wat de server meestuurde, niet wat de pagina ervan maakte.
      ready: window.__ready ?? null,
      status: document.getElementById('status')?.textContent ?? '',
    };
  });

  console.log(
    `\n  ${st.build} · fasen ${st.fasen.join(' ')} ${st.fasefout ? '· ' + st.fasefout : ''}`,
  );
  console.log(`  status: ${st.status}`);
  console.log(
    `  ready van de server: ${st.ready ? JSON.stringify(st.ready) : '(nooit ontvangen)'}\n`,
  );

  // Vraag één: bereikt de providerkeuze de browser? Zonder dit is elk beeldprobleem
  // hieronder niet te onderscheiden van een pagina die denkt dat er geen avatar is.
  eis('server meldde een provider', st.ready?.avatar != null, st.ready?.avatar ?? '(geen veld)');
  eis('er kwam een sessietoken', st.ready?.anamToken === '(aanwezig)', st.ready?.avatarFout ?? '');

  eis('element heeft oppervlak', st.w > 100 && st.h > 100, `${st.w}x${st.h}`);
  eis('element is zichtbaar', st.zichtbaar, `display: ${st.display}`);
  eis('element staat in beeld', st.binnenViewport);
  eis(
    'video speelt',
    !st.paused && st.readyState >= 2,
    `paused=${st.paused} readyState=${st.readyState}`,
  );
  eis(
    'alle fasen klaar',
    st.fasen.every((f) => f.endsWith(':klaar')),
    st.fasen.join(' '),
  );

  // De doorslaggevende controle: staan er pixels, en zijn ze niet allemaal gelijk?
  const shot = await (await page.$('#avatar')).screenshot();
  const kleuren = new Set();
  for (let i = 0; i < shot.length - 3; i += 331)
    kleuren.add(shot.subarray(i, i + 3).toString('hex'));
  eis('er zijn pixels geverfd', kleuren.size > 20, `${kleuren.size} unieke steekproeven`);

  eis('geen paginafouten', fouten.length === 0, fouten.slice(0, 2).join(' | '));
} catch (error) {
  console.log('  FOUT tijdens de controle:', String(error).slice(0, 200));
  mislukt = true;
} finally {
  await browser.close();
}

console.log(mislukt ? '\n  ZICHTBAARHEID NIET IN ORDE\n' : '\n  het gezicht is zichtbaar\n');
process.exit(mislukt ? 1 : 0);
