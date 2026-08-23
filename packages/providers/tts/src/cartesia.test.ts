import { describe, expect, it } from 'vitest';
import { CartesiaTtsStream } from './cartesia';

/**
 * Het wegsnijden van aanloopstilte, zonder netwerk.
 *
 * De chunks van Cartesia gaan rechtstreeks de berichtafhandeling in. Dat is wat er te
 * testen valt: het snijden is rekenwerk over samples, en het risico zit niet in het
 * transport maar in te veel pakken.
 */

const SR = 16_000;

function stroom() {
  const s = new CartesiaTtsStream(
    { apiKey: 'test', model: 'sonic-3', sampleRate: SR, trimLeadingSilence: true },
    { voiceId: 'v', language: 'nl' },
  );
  const chunks: Int16Array[] = [];
  s.on('audio', (c) => chunks.push(c.pcm));

  // `onMessage` en `contextId` zijn privé en horen dat te blijven; dit is het enige punt
  // waarop echte Cartesia-berichten te injecteren zijn.
  const intern = s as unknown as { onMessage(raw: string): void; contextId: string };
  const stuur = (pcm: Int16Array) =>
    intern.onMessage(
      JSON.stringify({
        type: 'chunk',
        context_id: intern.contextId,
        data: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64'),
      }),
    );
  return { s, stuur, chunks };
}

/** `ms` stilte. */
const stilte = (ms: number) => new Int16Array(Math.round((ms / 1000) * SR));

/** `ms` hoorbare toon op `amplitude` (fractie van de volle schaal). */
function geluid(ms: number, amplitude = 0.3): Int16Array {
  const n = Math.round((ms / 1000) * SR);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 200 * i) / SR) * amplitude * 32767);
  }
  return pcm;
}

function totaalMs(chunks: readonly Int16Array[]): number {
  return Math.round((chunks.reduce((n, c) => n + c.length, 0) / SR) * 1000);
}

describe('aanloopstilte wegsnijden', () => {
  it('gooit een volledig stille chunk weg en telt hem mee', () => {
    const { s, stuur, chunks } = stroom();
    stuur(stilte(200));
    expect(chunks).toHaveLength(0);
    expect(s.trimmedLeadingMs()).toBe(200);
  });

  it('snijdt binnen de chunk tot vlak vóór het eerste geluid', () => {
    const { s, stuur, chunks } = stroom();
    const pcm = new Int16Array(stilte(300).length + geluid(500).length);
    pcm.set(geluid(500), stilte(300).length);
    stuur(pcm);

    // 300 ms stilte min de 20 ms aanloop die blijft staan.
    expect(s.trimmedLeadingMs()).toBe(280);
    expect(totaalMs(chunks)).toBe(520);
  });

  it('laat een aanloopje staan zodat een zachte inzet niet wordt afgekapt', () => {
    const { stuur, chunks } = stroom();
    const stil = stilte(100);
    const pcm = new Int16Array(stil.length + geluid(200).length);
    pcm.set(geluid(200), stil.length);
    stuur(pcm);
    // De eerste 20 ms van het resultaat zijn nog stilte: dat is de bewaarde aanloop.
    expect(chunks[0]!.slice(0, 100).every((v) => v === 0)).toBe(true);
  });

  it('raakt stilte MIDDEN in een beurt niet aan', () => {
    // Dat is prosodie: de pauze tussen twee zinnen. Wegsnijden zou van de assistent een
    // ratelaar maken, en het is dataverlies aan de uitgaande kant.
    const { s, stuur, chunks } = stroom();
    stuur(geluid(300));
    stuur(stilte(400));
    stuur(geluid(300));
    expect(totaalMs(chunks)).toBe(1000);
    expect(s.trimmedLeadingMs()).toBe(0);
  });

  it('stopt met snijden boven de bovengrens', () => {
    // Blijft het langer dan twee seconden stil, dan is er iets anders aan de hand dan
    // prosodie; dat hoort zichtbaar te worden in plaats van weggesneden.
    const { s, stuur, chunks } = stroom();
    for (let i = 0; i < 5; i += 1) stuur(stilte(500));
    expect(s.trimmedLeadingMs()).toBeLessThanOrEqual(2000);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('snijdt alleen aan het begin van een beurt, niet bij elke chunk', () => {
    const { s, stuur, chunks } = stroom();
    stuur(stilte(200));
    stuur(geluid(300));
    const naEersteBeurt = s.trimmedLeadingMs();
    stuur(stilte(200));
    expect(s.trimmedLeadingMs()).toBe(naEersteBeurt);
    expect(totaalMs(chunks)).toBe(500);
  });
});

describe('de schakelaar', () => {
  it('laat de aanloopstilte staan als het snijden uit staat', () => {
    // Bestaat om met eigen oren te kunnen vergelijken: een klik hoor je, en op de
    // golfvorm is hij soms te klein om op te vallen.
    const s = new CartesiaTtsStream(
      { apiKey: 'test', model: 'sonic-3', sampleRate: SR, trimLeadingSilence: false },
      { voiceId: 'v', language: 'nl' },
    );
    const chunks: Int16Array[] = [];
    s.on('audio', (c) => chunks.push(c.pcm));
    const intern = s as unknown as { onMessage(raw: string): void; contextId: string };
    const stil = stilte(200);
    intern.onMessage(
      JSON.stringify({
        type: 'chunk',
        context_id: intern.contextId,
        data: Buffer.from(stil.buffer, stil.byteOffset, stil.byteLength).toString('base64'),
      }),
    );
    expect(totaalMs(chunks)).toBe(200);
    expect(s.trimmedLeadingMs()).toBe(0);
  });
});

describe('de samplerate over de WebSocket', () => {
  it('weigert een andere rate dan 16 kHz', async () => {
    // Cartesia negeert `sample_rate` over de WebSocket en levert altijd 16 kHz. Gemeten:
    // dezelfde zin gaf via REST 2,37 s op zowel 16000 als 24000, via de WebSocket bleef
    // het aantal samples gelijk — op 24000 "duurt" die dan 1,39 s. Wie hier een hogere
    // rate zet, labelt 16 kHz als 24 kHz en krijgt spraak die te snel klinkt.
    const s = new CartesiaTtsStream(
      { apiKey: 'test', model: 'sonic-3', sampleRate: 24_000, trimLeadingSilence: true },
      { voiceId: 'v', language: 'nl' },
    );
    await expect(s.connect()).rejects.toThrow(/24000 werkt niet over de WebSocket/);
  });
});
