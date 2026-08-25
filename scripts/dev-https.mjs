import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

/**
 * De webapp over HTTPS, zodat een echt toestel de microfoon mag openen.
 *
 * Waarom dit een script is en geen regel in package.json: het WS-adres moet meeveranderen.
 * Een https-pagina mag geen `ws://` openen — dat is gemengde inhoud en de browser blokkeert
 * het zonder melding — en het adres `localhost` wijst op de telefoon naar de telefoon. Beide
 * moeten dus wijzen naar het LAN-adres van deze machine, en dat adres kan na een herstart
 * anders zijn dan gisteren.
 *
 * Daarom leest dit script het adres uit, in plaats van het in `.env` te laten staan waar het
 * de gewone `pnpm dev` op de desktop zou breken.
 *
 * Draaien met: pnpm dev:https
 */

const HIER = process.cwd();
const CERTS = join(HIER, '.certs');

if (!existsSync(join(CERTS, 'lan.pem'))) {
  console.error('\n  Geen certificaat gevonden. Draai eerst: pnpm cert:lan\n');
  process.exit(1);
}

function lanAdres() {
  for (const [naam, lijst] of Object.entries(networkInterfaces())) {
    for (const net of lijst ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (/vmware|virtualbox|hyper-v|loopback/i.test(naam)) continue;
      return net.address;
    }
  }
  return null;
}

const ip = lanAdres();
if (!ip) {
  console.error('\n  Geen netwerkadres gevonden. Zit deze machine op wifi of een kabel?\n');
  process.exit(1);
}

const ws = `wss://${ip}:5174`;
console.log(`\n  Webapp   https://${ip}:3000`);
console.log(`  Worker   ${ws}   (start hem met: pnpm dev:live:https)\n`);
console.log(`  Cliëntscherm:  https://${ip}:3000/intake/vandijk-arbeidsrecht\n`);

const kind = spawn(
  'pnpm',
  [
    '--filter',
    '@intake/web',
    'exec',
    'next',
    'dev',
    '-H',
    '0.0.0.0',
    '-p',
    '3000',
    '--experimental-https',
    '--experimental-https-key',
    join(CERTS, 'lan-key.pem'),
    '--experimental-https-cert',
    join(CERTS, 'lan.pem'),
  ],
  {
    stdio: 'inherit',
    // Windows kent `pnpm` alleen als `pnpm.cmd`, en spawn weigert een .cmd zonder shell
    // (EINVAL sinds Node 18.20). Met shell werkt het op beide platformen.
    shell: true,
    // Overschrijft wat er in .env staat. Next leest NEXT_PUBLIC_* uit de omgeving en zet het
    // in de bundel; de waarde uit .env verliest hier dus, en dat is precies de bedoeling.
    env: { ...process.env, NEXT_PUBLIC_AGENT_WS_URL: ws },
  },
);

kind.on('exit', (code) => process.exit(code ?? 0));
