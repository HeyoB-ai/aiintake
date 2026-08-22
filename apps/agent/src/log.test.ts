import { afterEach, describe, expect, it, vi } from 'vitest';
import { log } from './log.js';

/**
 * §14: geen persoonsgegevens in applicatielogs. Logs worden breder bewaard en breder
 * ingezien dan de database, en deze intake gaat structureel over gezondheid en
 * arbeidsconflicten.
 */
describe('logger laat geen persoonsgegevens door', () => {
  const written: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });

  afterEach(() => {
    written.length = 0;
  });

  it('vervangt bekende gevoelige velden', () => {
    log.info('beurt verwerkt', {
      intakeId: 'abc-123',
      clientName: 'Jan de Vries',
      content: 'Ik ben sinds maart ziek.',
    });
    const line = written.at(-1)!;
    expect(line).toContain('abc-123');
    expect(line).not.toContain('Jan de Vries');
    expect(line).not.toContain('ziek');
  });

  it('kapt lange vrije tekst af, ook onder een onbekende sleutel', () => {
    log.info('debug', { aantekening: 'x'.repeat(400) });
    const line = written.at(-1)!;
    expect(line).not.toContain('x'.repeat(200));
    expect(line).toContain('400 tekens weggelaten');
  });

  it('laat metriek ongemoeid', () => {
    log.info('latency', { intakeId: 'abc-123', totalResponseLatencyMs: 940, turnIndex: 3 });
    const line = written.at(-1)!;
    expect(line).toContain('940');
    expect(line).toContain('"turnIndex":3');
  });

  it('houdt de spy in stand voor de hele suite', () => {
    expect(spy).toHaveBeenCalled();
  });
});
