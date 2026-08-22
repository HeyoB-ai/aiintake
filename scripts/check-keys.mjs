#!/usr/bin/env node
/**
 * Controleert of de leverancier-keys in .env daadwerkelijk werken.
 *
 * Waarom dit bestaat: een key die aanwezig is maar niet werkt, kost je een halve dag
 * debuggen middenin de realtime-lus — daar is een 401 nauwelijks van een timeout te
 * onderscheiden. Beter één keer expliciet vaststellen dat elke sleutel leeft.
 *
 * Elke controle gebruikt het goedkoopste read-only eindpunt dat de leverancier heeft.
 * Er wordt niets aangemaakt en niets gegenereerd, dus dit kost geen credits.
 *
 * Sleutelwaarden worden nooit afgedrukt — alleen de naam, de lengte en de uitkomst.
 */

import { existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const file of [join(ROOT, '.env'), join(ROOT, '.env.local')]) {
  if (existsSync(file)) {
    try {
      process.loadEnvFile(file);
    } catch {
      /* niets */
    }
  }
}

const TIMEOUT_MS = 12_000;

const results = [];

function record(vendor, status, detail, vars) {
  results.push({ vendor, status, detail, vars });
}

function missing(vendor, vars) {
  const leeg = vars.filter((v) => !process.env[v]);
  if (leeg.length === 0) return false;
  record(vendor, 'ontbreekt', `leeg of afwezig: ${leeg.join(', ')}`, vars);
  return true;
}

async function request(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Vertaalt een HTTP-status naar een uitspraak die ergens op slaat. */
function classify(response) {
  if (response.ok) return { status: 'ok', detail: `HTTP ${response.status}` };
  if (response.status === 401 || response.status === 403) {
    return { status: 'faalt', detail: `HTTP ${response.status} — key geweigerd` };
  }
  if (response.status === 404) {
    // Het eindpunt klopt niet meer; dat zegt niets over de key.
    return { status: 'onduidelijk', detail: `HTTP 404 — eindpunt bestaat niet (meer)` };
  }
  return { status: 'onduidelijk', detail: `HTTP ${response.status}` };
}

// ---------------------------------------------------------------------- checks

async function checkDeepgram() {
  const vars = ['DEEPGRAM_API_KEY'];
  if (missing('Deepgram', vars)) return;
  try {
    const res = await request('https://api.deepgram.com/v1/projects', {
      headers: { Authorization: `Token ${process.env['DEEPGRAM_API_KEY']}` },
    });
    const { status, detail } = classify(res);
    record('Deepgram', status, detail, vars);
  } catch (error) {
    record('Deepgram', 'faalt', netError(error), vars);
  }
}

/**
 * Anthropic.
 *
 * Een `max_tokens: 1`-aanroep en niet een lijst-endpoint: die bestaat niet, en een key
 * die formeel geldig is maar geen credit heeft, faalt pas op de eerste echte aanroep.
 * Liever hier dan halverwege een latencymeting.
 */
async function checkAnthropic() {
  const vars = ['ANTHROPIC_API_KEY'];
  if (missing('Anthropic', vars)) return;
  try {
    const res = await request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env['ANTHROPIC_API_KEY'],
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env['LLM_HOT_MODEL'] ?? 'claude-haiku-4-5-20251001',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const { status, detail } = classify(res);
    record('Anthropic', status, detail, vars);
  } catch (error) {
    record('Anthropic', 'faalt', netError(error), vars);
  }
}

async function checkCartesia() {
  const vars = ['CARTESIA_API_KEY'];
  if (missing('Cartesia', vars)) return;
  try {
    const res = await request('https://api.cartesia.ai/voices/?limit=1', {
      headers: {
        'X-API-Key': process.env['CARTESIA_API_KEY'],
        'Cartesia-Version': '2024-06-10',
      },
    });
    const { status, detail } = classify(res);
    record('Cartesia', status, detail, vars);
  } catch (error) {
    record('Cartesia', 'faalt', netError(error), vars);
  }
}

async function checkBeyondPresence() {
  const vars = ['BEY_API_KEY'];
  if (missing('Beyond Presence', vars)) return;
  try {
    const res = await request('https://api.bey.dev/v1/avatar', {
      headers: { 'x-api-key': process.env['BEY_API_KEY'] },
    });
    const { status, detail } = classify(res);

    let extra = detail;
    if (res.ok && process.env['BEY_AVATAR_ID']) {
      const body = await res.json().catch(() => null);
      const list = Array.isArray(body) ? body : (body?.data ?? []);
      const ids = list.map((a) => a?.id).filter(Boolean);
      extra = `${detail}, ${ids.length} avatars`;
      if (ids.length > 0 && !ids.includes(process.env['BEY_AVATAR_ID'])) {
        record('Beyond Presence', 'let op', `${extra} — BEY_AVATAR_ID komt niet voor in de lijst`, [
          ...vars,
          'BEY_AVATAR_ID',
        ]);
        return;
      }
    }
    record('Beyond Presence', status, extra, vars);
  } catch (error) {
    record('Beyond Presence', 'faalt', netError(error), vars);
  }
}

async function checkAnam() {
  const vars = ['ANAM_API_KEY'];
  if (missing('Anam', vars)) return;
  try {
    // Anam geeft een kortlevend sessietoken uit; dat is hun goedkoopste bewijs dat de
    // key leeft. Er wordt geen sessie mee gestart, dus er lopen geen minuten.
    const res = await request('https://api.anam.ai/v1/auth/session-token', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env['ANAM_API_KEY']}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const { status, detail } = classify(res);
    record('Anam', status, detail, vars);
  } catch (error) {
    record('Anam', 'faalt', netError(error), vars);
  }
}

async function checkLiveKit() {
  const vars = ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
  if (missing('LiveKit', vars)) return;

  const url = process.env['LIVEKIT_URL'];
  if (!/^wss?:\/\/[^/]+/.test(url) || url === 'wss://') {
    record('LiveKit', 'ontbreekt', 'LIVEKIT_URL is geen hostnaam maar een placeholder', vars);
    return;
  }

  try {
    const token = livekitToken(process.env['LIVEKIT_API_KEY'], process.env['LIVEKIT_API_SECRET']);
    const http = url.replace(/^ws/, 'http');
    const res = await request(`${http}/twirp/livekit.RoomService/ListRooms`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    const { status, detail } = classify(res);
    record('LiveKit', status, detail, vars);
  } catch (error) {
    record('LiveKit', 'faalt', netError(error), vars);
  }
}

/** Minimaal LiveKit-servertoken. HS256, zonder SDK — het is één HMAC. */
function livekitToken(apiKey, apiSecret) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: apiKey,
      sub: apiKey,
      iat: now,
      exp: now + 60,
      nbf: now - 5,
      video: { roomList: true },
    }),
  );
  const signature = createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64urlBytes(signature)}`;
}

const b64url = (s) => b64urlBytes(Buffer.from(s, 'utf8'));
const b64urlBytes = (b) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function netError(error) {
  if (error?.name === 'AbortError') return `geen antwoord binnen ${TIMEOUT_MS / 1000}s`;
  return error?.cause?.code ?? error?.message ?? 'onbekende netwerkfout';
}

// ------------------------------------------------------------------------ main

await Promise.all([
  checkLiveKit(),
  checkAnthropic(),
  checkDeepgram(),
  checkCartesia(),
  checkBeyondPresence(),
  checkAnam(),
]);

const ORDER = ['LiveKit', 'Deepgram', 'Cartesia', 'Beyond Presence', 'Anam'];
results.sort((a, b) => ORDER.indexOf(a.vendor) - ORDER.indexOf(b.vendor));

const mark = {
  ok: 'OK        ',
  faalt: 'FAALT     ',
  ontbreekt: 'ONTBREEKT ',
  'let op': 'LET OP    ',
  onduidelijk: 'ONDUIDELIJK',
};

process.stdout.write('\nleverancier-keys\n\n');
for (const r of results) {
  process.stdout.write(`  ${mark[r.status] ?? r.status} ${r.vendor.padEnd(17)} ${r.detail}\n`);
}

const bruikbaar = results.filter((r) => r.status === 'ok').length;
process.stdout.write(`\n  ${bruikbaar}/${results.length} bruikbaar\n\n`);

// Ontbrekende keys zijn geen fout van dit script; falende wel de moeite van een
// exit code waard, zodat CI of een scriptje erop kan afgaan.
process.exitCode = results.some((r) => r.status === 'faalt') ? 1 : 0;
