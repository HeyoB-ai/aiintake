import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

/**
 * De root-CA uitdelen aan een toestel op het lokale netwerk.
 *
 * Dit staat expres op platte HTTP en op een eigen poort. De telefoon moet dit certificaat
 * ophalen om HTTPS te kunnen vertrouwen — het over diezelfde HTTPS aanbieden is een kip die
 * op zijn eigen ei wacht. Er gaat hier niets geheims overheen: een CA-certificaat is de
 * publieke helft. De privésleutel (`rootCA-key.pem`) wordt nooit geserveerd.
 *
 * Draaien met: pnpm cert:serve
 */

const POORT = Number(process.env['CERT_PORT'] ?? 3001);
const BESTAND = join(process.cwd(), '.certs', 'rootCA.pem');

if (!existsSync(BESTAND)) {
  console.error('\n  .certs/rootCA.pem ontbreekt. Draai eerst: pnpm cert:lan\n');
  process.exit(1);
}

const pem = readFileSync(BESTAND);

const server = createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/rootCA.pem') {
    res.writeHead(404).end('niet gevonden');
    return;
  }
  /*
   * Dit MIME-type is wat iOS een profiel laat aanbieden in plaats van een tekstbestand te
   * tonen. Met `text/plain` krijg je het certificaat als leesbare onzin op het scherm en
   * gebeurt er verder niets — dat is de gebruikelijke manier waarop dit misgaat.
   */
  res.writeHead(200, {
    'content-type': 'application/x-x509-ca-cert',
    'content-disposition': 'attachment; filename="legal-intake-lokaal.pem"',
  });
  res.end(pem);
});

function lanAdres() {
  for (const [naam, lijst] of Object.entries(networkInterfaces())) {
    for (const net of lijst ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (/vmware|virtualbox|hyper-v|loopback/i.test(naam)) continue;
      return net.address;
    }
  }
  return 'localhost';
}

server.listen(POORT, '0.0.0.0', () => {
  const ip = lanAdres();
  console.log(`\n  Open op de telefoon:  http://${ip}:${POORT}\n`);
  console.log('  Daarna: Instellingen > Algemeen > VPN en apparaatbeheer > profiel > Installeer,');
  console.log('  en dan Instellingen > Algemeen > Info > Certificaatvertrouwensinstellingen aan.\n');
  console.log('  Ctrl+C als het geïnstalleerd is — dit hoeft niet te blijven draaien.\n');
});
