#!/usr/bin/env node
/**
 * Sluit een rotatie af: trekt elk workergeheim in behálve het geheim dat nu draait.
 *
 * Zie RISICOS.md risico 31. Draai dit pas als aan alle drie is voldaan:
 *
 *   1. het nieuwe geheim is gezet (`node scripts/set-worker-secret.mjs`)
 *   2. het staat bij de worker (Railway) en die is uitgerold
 *   3. de worker meldt bij het opstarten "workergeheim: herkend"
 *
 * Eerder draaien legt de dienst stil: de worker draait dan nog op een geheim dat je zojuist
 * hebt ingetrokken, en elke schrijfactie faalt met een melding over het sessietoken.
 *
 * ## Waarom dit de hash wil en niet het geheim
 *
 * De hash is niet geheim — hij staat al in de database en er valt niets uit terug te
 * rekenen. Het geheim zelf hoort op precies één plek te staan, en dat is de omgeving van de
 * worker. Een script dat erom vraagt, is een uitnodiging om het ergens anders te plakken.
 *
 * `set-worker-secret.mjs` print de hash mee, samen met het commando dat je hier nodig hebt.
 *
 * Draaien met: node scripts/retire-worker-secrets.mjs <hash-van-het-geheim-dat-blijft>
 */

import { readFileSync } from 'node:fs';

function leesEnv() {
  const env = { ...process.env };
  try {
    for (const regel of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(regel.trim());
      if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // Geen .env is prima: op een operatormachine staan de variabelen in de omgeving.
  }
  return env;
}

const env = leesEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const secret = env.SUPABASE_SECRET_KEY;
const houden = process.argv[2];

if (!url || !secret) {
  process.stdout.write('\n  NEXT_PUBLIC_SUPABASE_URL en SUPABASE_SECRET_KEY zijn nodig.\n\n');
  process.exit(1);
}

if (!houden || !/^[0-9a-f]{64}$/.test(houden)) {
  process.stdout.write(
    '\n  Geef de hash van het geheim dat moet BLIJVEN — 64 hextekens.\n' +
      '  Die staat in de uitvoer van scripts/set-worker-secret.mjs.\n\n' +
      '      node scripts/retire-worker-secrets.mjs <hash>\n\n' +
      '  Niet het geheim zelf: dat hoort op precies één plek te staan, bij de worker.\n\n',
  );
  process.exit(1);
}

const res = await fetch(`${url}/rest/v1/rpc/retire_other_worker_secrets`, {
  method: 'POST',
  headers: {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ p_keep_hash: houden }),
});

if (!res.ok) {
  const tekst = await res.text();
  process.stdout.write(`\n  Intrekken mislukt: HTTP ${res.status} ${tekst}\n`);
  if (tekst.includes('niet actief')) {
    process.stdout.write(
      '\n  De hash die je opgaf is geen actief geheim. Er is niets ingetrokken, en dat is\n' +
        '  precies de bedoeling: bij een typefout zou anders álles worden ingetrokken en\n' +
        '  ligt de dienst stil.\n\n',
    );
  }
  process.exit(1);
}

const aantal = await res.json();
process.stdout.write(
  `\n  ${aantal} geheim(en) ingetrokken. Er is er nu nog één actief.\n\n` +
    '  Controleer dat de worker nog steeds "workergeheim: herkend" meldt — dat kan zonder\n' +
    '  opnieuw uit te rollen: herstart hem, of kijk in het log van de laatste start.\n\n',
);
