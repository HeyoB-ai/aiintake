import { connect as tlsConnect } from 'node:tls';

/**
 * Hoe groot is de netwerkpost per regio?
 *
 * De TTFT-diagnose liet zien dat ~205 ms van de 619 ms niets met het model te maken had.
 * De vraag die daarop volgt is of een EU-endpoint dat wegneemt — en of wat er overblijft
 * nog onder de budgetregel van 300 ms past.
 *
 * Dit meet zonder credentials. Een TCP-handshake en een TLS-handshake vragen geen sleutel,
 * en een onbevoegd verzoek levert een snelle 401 of 403 op zonder dat er een model draait.
 * Dat is precies wat we willen weten: de reistijd, los van de inferentie.
 *
 * **Let op de vergelijkbaarheid.** De 205 ms uit de TTFT-diagnose was een *geauthenticeerde*
 * GET die aan de overkant echt werk deed. De getallen hieronder zijn onbevoegde verzoeken.
 * Om die reden staat api.anthropic.com hier óók in: alleen door alle drie op dezelfde
 * manier te meten is het verschil tussen de regio's te vertrouwen.
 *
 * Draaien met: pnpm diag:netwerk
 */

const RONDES = 5;

interface Doel {
  readonly naam: string;
  readonly host: string;
  readonly url: string;
  readonly plaats: string;
}

const DOELEN: readonly Doel[] = [
  {
    naam: 'Anthropic (huidig)',
    host: 'api.anthropic.com',
    url: 'https://api.anthropic.com/v1/models?limit=1',
    plaats: 'VS',
  },
  {
    naam: 'Bedrock eu-central-1',
    host: 'bedrock-runtime.eu-central-1.amazonaws.com',
    url: 'https://bedrock-runtime.eu-central-1.amazonaws.com/model/x/invoke',
    plaats: 'Frankfurt',
  },
  {
    naam: 'Vertex europe-west4',
    host: 'europe-west4-aiplatform.googleapis.com',
    url: 'https://europe-west4-aiplatform.googleapis.com/v1/publishers/anthropic/models',
    plaats: 'Eemshaven (NL)',
  },
];

/** TCP-connect is de zuiverste benadering van de round trip: één heen en weer. */
function handshake(host: string): Promise<{ tcpMs: number; tlsMs: number }> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    let tcp = 0;
    const socket = tlsConnect({ host, port: 443, servername: host }, () => {
      const tls = performance.now() - t0;
      socket.destroy();
      resolve({ tcpMs: Math.round(tcp), tlsMs: Math.round(tls) });
    });
    socket.on('connect', () => {
      tcp = performance.now() - t0;
    });
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.on('error', reject);
  });
}

/** Volledig verzoek over een warme verbinding: wat een echte aanroep aan reistijd kost. */
async function verzoek(url: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url, { method: 'GET' });
  await res.arrayBuffer();
  return Math.round(performance.now() - t0);
}

function mediaan(waarden: number[]): number {
  const g = [...waarden].sort((a, b) => a - b);
  return g[Math.floor(g.length / 2)] ?? 0;
}

console.log('\n  Netwerkpost per regio — vanaf deze machine, zonder credentials\n');
console.log(
  `  ${'endpoint'.padEnd(24)}${'plaats'.padEnd(17)}${'tcp'.padEnd(9)}${'tls'.padEnd(9)}${'warm verzoek'}`,
);

const uitslag: { naam: string; tcp: number; warm: number }[] = [];

for (const doel of DOELEN) {
  const tcps: number[] = [];
  const tlss: number[] = [];
  try {
    for (let i = 0; i < RONDES; i += 1) {
      const h = await handshake(doel.host);
      tcps.push(h.tcpMs);
      tlss.push(h.tlsMs);
    }
  } catch (error) {
    console.log(
      `  ${doel.naam.padEnd(24)}${doel.plaats.padEnd(17)}FOUT: ${(error as Error).message}`,
    );
    continue;
  }

  const warms: number[] = [];
  // Eerste verzoek warmt de verbinding op en telt niet mee; daarna is het hergebruik.
  await verzoek(doel.url).catch(() => 0);
  for (let i = 0; i < RONDES; i += 1) {
    warms.push(await verzoek(doel.url).catch(() => -1));
  }
  const geldig = warms.filter((w) => w >= 0);

  const tcp = mediaan(tcps);
  const warm = geldig.length > 0 ? mediaan(geldig) : -1;
  uitslag.push({ naam: doel.naam, tcp, warm });

  console.log(
    `  ${doel.naam.padEnd(24)}${doel.plaats.padEnd(17)}` +
      `${(tcp + ' ms').padEnd(9)}${(mediaan(tlss) + ' ms').padEnd(9)}` +
      `${warm >= 0 ? warm + ' ms' : '—'}`,
  );
}

const huidig = uitslag.find((u) => u.naam.startsWith('Anthropic'));
if (huidig) {
  console.log('\n  Verschil in round trip ten opzichte van het huidige endpoint:');
  for (const u of uitslag) {
    if (u === huidig) continue;
    const winst = huidig.tcp - u.tcp;
    console.log(
      `    ${u.naam.padEnd(24)}${winst >= 0 ? '-' : '+'}${Math.abs(winst)} ms per round trip`,
    );
  }
}

console.log(
  '\n  Kanttekening: dit is reistijd, geen inferentie. De ~310 ms die het starten van de\n' +
    '  generatie kost, zit hier niet in en verdwijnt niet door van regio te wisselen.\n',
);

process.exit(0);
