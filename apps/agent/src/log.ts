/**
 * Logging zonder persoonsgegevens (§14).
 *
 * Log intake-id's, geen namen, geen transcriptfragmenten, geen documentinhoud. Dit is
 * geen stijlregel: de intake gaat structureel over gezondheid en arbeidsconflicten,
 * en applicatielogs worden doorgaans breder bewaard en breder ingezien dan de database.
 *
 * De filter hieronder is een vangnet, geen vrijbrief — velden met vrije tekst horen
 * niet aan de logger meegegeven te worden.
 */

const FORBIDDEN_KEYS = new Set([
  'content',
  'intendedContent',
  'transcript',
  'clientName',
  'client_name',
  'clientEmail',
  'client_email',
  'clientPhone',
  'client_phone',
  'email',
  'name',
  'body',
  'evidenceQuote',
  'evidence_quote',
  'summary',
  'value',
]);

type Fields = Record<string, unknown>;

function scrub(fields: Fields): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key)) {
      out[key] = '[weggelaten]';
    } else if (typeof value === 'string' && value.length > 120) {
      out[key] = `[${value.length} tekens weggelaten]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function emit(level: 'info' | 'warn' | 'error', message: string, fields?: Fields): void {
  const line = JSON.stringify({
    level,
    message,
    ...(fields ? scrub(fields) : {}),
    ts: new Date().toISOString(),
  });
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};
