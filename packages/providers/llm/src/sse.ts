/**
 * Server-sent events lezen, één keer.
 *
 * Anthropic direct en Anthropic-op-Vertex spreken hetzelfde streamprotocol; alleen de
 * URL en de authenticatie verschillen. Dit stukje twee keer schrijven zou betekenen dat
 * een fout in de bufferafhandeling ook twee keer gemaakt kan worden — en juist daar zit
 * de subtiliteit: een SSE-gebeurtenis kan over twee TCP-reads gesplitst binnenkomen, en
 * wie de rest niet bewaart, verliest tokens zonder dat er iets misgaat.
 */

export interface SseEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  message?: {
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  usage?: { output_tokens?: number };
}

/** Leest een SSE-body en levert de geparste gebeurtenissen, in volgorde. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Gebeurtenissen worden gescheiden door een lege regel. Alles tot de laatste
      // volledige scheiding is compleet; de rest blijft staan tot de volgende read.
      const blokken = buffer.split('\n\n');
      buffer = blokken.pop() ?? '';

      for (const blok of blokken) {
        for (const regel of blok.split('\n')) {
          if (!regel.startsWith('data:')) continue;
          const payload = regel.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            yield JSON.parse(payload) as SseEvent;
          } catch {
            // Een onleesbare gebeurtenis is geen reden om de beurt te laten vallen.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Wat we uit een stroom gebeurtenissen halen: tekst eruit, verbruik apart bijhouden. */
export interface StreamTotals {
  inputTokens: number | null;
  outputTokens: number | null;
  /** Tijdstip van het eerste tekstfragment; de basis voor TTFT. */
  firstTokenAt: number | null;
}

/**
 * Haalt de tekstfragmenten uit de gebeurtenissen en houdt het verbruik bij.
 *
 * `totals` wordt ter plekke bijgewerkt, zodat de aanroeper na afloop het verbruik heeft
 * zonder dat deze functie twee dingen hoeft terug te geven.
 */
export async function* textFromSse(
  events: AsyncIterable<SseEvent>,
  totals: StreamTotals,
): AsyncIterable<string> {
  for await (const event of events) {
    if (event.type === 'message_start' && event.message?.usage) {
      totals.inputTokens = event.message.usage.input_tokens ?? null;
    }
    if (event.type === 'message_delta' && event.usage) {
      totals.outputTokens = event.usage.output_tokens ?? null;
    }
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const tekst = event.delta.text ?? '';
      if (tekst) {
        totals.firstTokenAt ??= Date.now();
        yield tekst;
      }
    }
  }
}
