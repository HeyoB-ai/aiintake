import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { createCA, createCert } from 'mkcert';

/**
 * Een certificaat voor het lokale netwerk, zodat je op een echt toestel kunt testen.
 *
 * ## Waarom dit moet
 *
 * `getUserMedia` bestaat alleen in een beveiligde context. HTTPS, of `localhost` — en
 * `localhost` op je telefoon is je telefoon, niet je laptop. Op `http://192.168.x.x`
 * weigert elke browser de microfoon, en dat is geen instelling die je aan kunt zetten.
 *
 * ## Waarom één certificaat voor twee servers
 *
 * De pagina draait op Next, het gesprek loopt over een WebSocket naar de worker. Een
 * `https`-pagina mag geen `ws://` openen — dat is gemengde inhoud en de browser blokkeert
 * het zonder zichtbare melding. Beide moeten dus TLS hebben, en met hetzelfde certificaat
 * hoef je op de telefoon maar één ding te vertrouwen.
 *
 * ## Wat hier niet gebeurt
 *
 * Dit is niets voor productie. Een zelfondertekende CA op je eigen machine is prima om een
 * telefoon mee te testen; hem ergens anders installeren is een sleutel weggeven waarmee
 * elke site te vervalsen is. De bestanden staan in `.certs/`, dat in .gitignore hoort.
 *
 * Draaien met: pnpm cert:lan
 */

const HIER = process.cwd();
const MAP = join(HIER, '.certs');

/** Het LAN-adres van deze machine. VMware- en loopback-adressen tellen niet mee. */
function lanAdressen() {
  const uit = [];
  for (const [naam, lijst] of Object.entries(networkInterfaces())) {
    for (const net of lijst ?? []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      // Virtuele adapters zijn niet het adres waarop je telefoon je vindt.
      if (/vmware|virtualbox|hyper-v|loopback/i.test(naam)) continue;
      uit.push({ adres: net.address, adapter: naam });
    }
  }
  return uit;
}

const adressen = lanAdressen();
if (adressen.length === 0) {
  console.error('\n  Geen netwerkadres gevonden. Zit deze machine op wifi of een kabel?\n');
  process.exit(1);
}

const ips = adressen.map((a) => a.adres);
console.log('\n  Certificaat voor:');
for (const a of adressen) console.log(`    ${a.adres.padEnd(16)} (${a.adapter})`);
console.log('    localhost, 127.0.0.1\n');

const ca = await createCA({
  // Alleen ASCII: node-forge codeert dit als PrintableString en struikelt over
  // niet-ASCII tekens — het schrijft dan een certificaat dat het zelf niet kan lezen.
  organization: 'Legal Intake AI Lokaal Testen',
  countryCode: 'NL',
  state: 'Utrecht',
  locality: 'Lokaal',
  // Een jaar. Langer is onnodig en maakt een vergeten CA op een telefoon gevaarlijker.
  validity: 365,
});

const cert = await createCert({
  ca: { key: ca.key, cert: ca.cert },
  // `domains` accepteert ook IP-adressen; mkcert zet ze als SAN neer, en dat is wat een
  // browser controleert. Zonder de IP's erin is het certificaat geldig voor localhost en
  // nutteloos voor je telefoon.
  domains: ['localhost', '127.0.0.1', ...ips],
  validity: 365,
});

mkdirSync(MAP, { recursive: true });
writeFileSync(join(MAP, 'rootCA.pem'), ca.cert);
writeFileSync(join(MAP, 'rootCA-key.pem'), ca.key);
writeFileSync(join(MAP, 'lan.pem'), cert.cert);
writeFileSync(join(MAP, 'lan-key.pem'), cert.key);

const gitignore = join(HIER, '.gitignore');
const heeftRegel =
  existsSync(gitignore) &&
  /(^|\n)\.certs\//.test(
    String(await import('node:fs').then((fs) => fs.readFileSync(gitignore, 'utf8'))),
  );
if (!heeftRegel) {
  console.log('  LET OP: zet `.certs/` in .gitignore. Een privésleutel hoort niet in git.\n');
}

const eerste = ips[0];
console.log('  Bestanden in .certs/\n');
console.log('  1. Start beide servers met TLS:');
console.log('       pnpm dev:https        (de webapp op https://' + eerste + ':3000)');
console.log('       pnpm dev:live:https   (de worker op wss://' + eerste + ':5174)\n');
console.log('  2. Zet in .env:');
console.log(`       NEXT_PUBLIC_AGENT_WS_URL=wss://${eerste}:5174\n`);
console.log('  3. Vertrouw de CA op de iPhone:');
console.log('       a. Draai in een tweede terminal:  pnpm cert:serve');
console.log(`       b. Open op de telefoon:  http://${eerste}:3001`);
console.log('       c. Safari vraagt of je een profiel wilt toestaan — sta toe.');
console.log(
  '       d. Instellingen > Algemeen > VPN en apparaatbeheer > het profiel > Installeer.',
);
console.log('       e. Instellingen > Algemeen > Info > Certificaatvertrouwensinstellingen:');
console.log('          zet de schakelaar bij "Legal Intake AI Lokaal Testen" AAN. Zonder');
console.log('          deze stap vertrouwt iOS de CA nog steeds niet — dit is de stap');
console.log('          die iedereen mist.\n');
console.log(`  4. Open op de telefoon: https://${eerste}:3000/intake/vandijk-arbeidsrecht\n`);
