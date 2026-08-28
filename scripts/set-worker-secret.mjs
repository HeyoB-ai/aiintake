#!/usr/bin/env node
/**
 * Genereert het workergeheim en slaat de hash op.
 *
 * Zie RISICOS.md risico 31. Het sessietoken bewijst wélke intake; dit geheim bewijst dát je
 * de worker bent. De browser van de cliënt heeft het eerste en niet het tweede.
 *
 * ## Wat dit script wel en niet doet
 *
 * Het genereert een geheim, print het één keer, en stuurt alleen de hash naar de database.
 * Het ruwe geheim wordt nergens opgeslagen — niet in een bestand, niet in de database, niet
 * in een logregel. Ben je het kwijt, dan draai je dit script opnieuw en trek je het oude in.
 *
 * ## De volgorde bij het uitrollen
 *
 *   1. push migratie 20260828120000
 *   2. dit script draaien
 *   3. AGENT_WORKER_SECRET bij de worker zetten (Railway) en uitrollen
 *   4. controleren dat de worker "workergeheim: herkend" meldt bij het opstarten
 *   5. push migratie 20260828120100 — pas dan wordt er afgedwongen
 *
 * ## Roteren
 *
 * Dit script nog een keer draaien met een ander label. Twee geheimen mogen tegelijk actief
 * zijn; dat is de hele rotatiestrategie. Zet het nieuwe bij de worker, rol uit, controleer, en
 * trek daarna het oude in met `retire_worker_secret`. Zonder die overlap zou roteren een
 * onderbreking betekenen, en dan wordt er niet geroteerd.
 *
 * Draaien met: node scripts/set-worker-secret.mjs [label]
 */

import { readFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';

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

/** Moet exact overeenkomen met `app.hash_session_token()`; dezelfde hash, dezelfde codering. */
async function hash(geheim) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(geheim));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

const env = leesEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL;
const secret = env.SUPABASE_SECRET_KEY;

if (!url || !secret) {
  process.stdout.write(
    '\n  NEXT_PUBLIC_SUPABASE_URL en SUPABASE_SECRET_KEY zijn nodig.\n' +
      '  Dit script zet het geheim namens de web-app; de worker mag zijn eigen\n' +
      '  credential niet aanmaken. Zie packages/db/src/agent-session.ts.\n\n',
  );
  process.exit(1);
}

const label = process.argv[2] ?? 'handmatig gezet';

// 32 bytes uit de CSPRNG, base64url — dezelfde vorm als een sessietoken.
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
const geheim = base64url(bytes);
const geheimHash = await hash(geheim);

const res = await fetch(`${url}/rest/v1/rpc/set_worker_secret`, {
  method: 'POST',
  headers: {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ p_secret_hash: geheimHash, p_label: label }),
});

if (!res.ok) {
  process.stdout.write(`\n  Opslaan mislukt: HTTP ${res.status} ${await res.text()}\n`);
  process.stdout.write(
    '  Staat migratie 20260828120000 al op de database? Zonder die migratie bestaat\n' +
      '  set_worker_secret niet.\n\n',
  );
  process.exit(1);
}

process.stdout.write(
  `
  Workergeheim aangemaakt en opgeslagen (label: ${label}).

  Zet dit bij de WORKER, en nergens anders:

      AGENT_WORKER_SECRET=${geheim}

  Het wordt hierna niet meer getoond en staat nergens opgeslagen — de database kent
  alleen de hash. Kwijt? Draai dit script opnieuw en trek het oude in.

  Niet in apps/web zetten: die weigert dan te starten (geen-workergeheim.ts), en dat
  is opzet — het geheim op twee plekken is hoe geheimen uiteindelijk lekken.

  Daarna:
    1. worker uitrollen en controleren op "workergeheim: herkend"
    2. pas dán migratie 20260828120100 pushen

`,
);
