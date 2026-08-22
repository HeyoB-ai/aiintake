import { createSign } from 'node:crypto';
import type { LLMProvider, LlmUsage, StructuredRequest, TextRequest } from './contract';
import { readSse, textFromSse, type StreamTotals } from './sse';
import type { Validated } from '@intake/domain';

/**
 * Claude via Vertex AI, in `europe-west4`.
 *
 * ## Waarom Vertex europe-west4 en niet Bedrock eu-central-1
 *
 * Gemeten vanaf een machine in Nederland (`pnpm diag:netwerk`):
 *
 *   Vertex europe-west4 (Eemshaven)   tcp 10 ms   tls 30 ms   warm verzoek 15 ms
 *   Bedrock eu-central-1 (Frankfurt)  tcp 19 ms   tls 49 ms   warm verzoek 16 ms
 *
 * Op het warme verzoek ontlopen ze elkaar niets. Op de handshake is Eemshaven bijna
 * twee keer zo dichtbij, en dat telt bij elke nieuwe verbinding — bij een worker die
 * herstart, bij het opschalen, en bij elke koude sessie.
 *
 * De doorslag geeft echter niet de milliseconde maar de vestigingsplaats. `europe-west4`
 * staat in Nederland. Voor een Nederlands advocatenkantoor dat vraagt waar de data staat,
 * is "in Nederland" een wezenlijk ander antwoord dan "in Duitsland" — en dat is precies
 * de vraag die volgens het architectuurdocument binnen tien minuten gesteld wordt.
 *
 * **Wat nog geverifieerd moet worden:** of het gekozen Haiku-model daadwerkelijk in
 * `europe-west4` wordt aangeboden. Dat is niet zonder credentials te controleren, en het
 * is een harde voorwaarde — is het er niet, dan is Frankfurt de terugval en kost dat
 * ongeveer negen milliseconde plus een zwakker verhaal richting de klant.
 *
 * ## Authenticatie
 *
 * Google wil een OAuth2-token, geen API-key. Dat token komt uit een service-account:
 * een JWT die wij ondertekenen met de private key, ingewisseld voor een access token dat
 * een uur geldig is. Met `node:crypto` en zonder SDK, om dezelfde reden als bij LiveKit —
 * het is één handtekening, en je wilt kunnen zien wat er in de claim staat.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** Ruim vóór het verloopt vernieuwen; een token dat tijdens een beurt verloopt kost de beurt. */
const VERNIEUW_MARGE_S = 300;

export interface VertexOptions {
  readonly projectId: string;
  readonly region?: string;
  readonly clientEmail: string;
  /** PEM, zoals hij in de service-account-JSON staat. */
  readonly privateKey: string;
  readonly maxRepairAttempts?: number;
}

export class VertexAnthropicProvider implements LLMProvider {
  readonly id = 'vertex-anthropic';
  private usage: LlmUsage = { inputTokens: null, outputTokens: null, latencyMs: null };
  private token: { waarde: string; verlooptOp: number } | null = null;
  private readonly region: string;

  constructor(private readonly options: VertexOptions) {
    if (!options.projectId) throw new Error('VertexAnthropicProvider: projectId ontbreekt');
    if (!options.clientEmail) throw new Error('VertexAnthropicProvider: clientEmail ontbreekt');
    if (!options.privateKey) throw new Error('VertexAnthropicProvider: privateKey ontbreekt');
    this.region = options.region ?? 'europe-west4';
  }

  async *streamText(request: TextRequest): AsyncIterable<string> {
    const gestart = Date.now();
    const totals: StreamTotals = { inputTokens: null, outputTokens: null, firstTokenAt: null };

    const response = await fetch(this.url(request.model, true), {
      method: 'POST',
      headers: await this.headers(),
      signal: request.signal ?? null,
      body: JSON.stringify({
        // Op Vertex staat de modelnaam in de URL en niet in de body; in ruil daarvoor
        // moet `anthropic_version` mee.
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: request.maxTokens ?? 300,
        stream: true,
        system: request.system,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Vertex: HTTP ${response.status} — ${detail.slice(0, 300)}`);
    }

    try {
      yield* textFromSse(readSse(response.body), totals);
    } finally {
      this.usage = {
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        // Tijd tot het EERSTE token, niet tot het laatste: dat is het getal uit de
        // begroting. De totale duur bepaalt hoe lang de zin is, niet wanneer de mond
        // begint te bewegen.
        latencyMs: totals.firstTokenAt === null ? null : totals.firstTokenAt - gestart,
      };
    }
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<Validated<T>> {
    const maxPogingen = (request.maxRepairAttempts ?? this.options.maxRepairAttempts ?? 1) + 1;
    const gestart = Date.now();
    let laatsteRuw = '';
    let laatsteFout = '';

    for (let poging = 0; poging < maxPogingen; poging += 1) {
      const input =
        poging === 0
          ? request.input
          : `${request.input}\n\nJe vorige antwoord was ongeldig:\n${laatsteRuw.slice(0, 2000)}\n\nFout: ${laatsteFout}\n\nGeef opnieuw antwoord, nu volgens het schema.`;

      const response = await fetch(this.url(request.model, false), {
        method: 'POST',
        headers: await this.headers(),
        body: JSON.stringify({
          anthropic_version: 'vertex-2023-10-16',
          max_tokens: 4096,
          system: request.system,
          messages: [{ role: 'user', content: input }],
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Vertex: HTTP ${response.status} — ${detail.slice(0, 300)}`);
      }

      const body = (await response.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      this.usage = {
        inputTokens: body.usage?.input_tokens ?? null,
        outputTokens: body.usage?.output_tokens ?? null,
        latencyMs: Date.now() - gestart,
      };

      laatsteRuw = (body.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');

      const geparsed = parseJson(laatsteRuw);
      if (!geparsed.ok) {
        laatsteFout = geparsed.error;
        continue;
      }
      if (request.schema.safeParse(geparsed.value).success) {
        return {
          data: request.schema.parse(geparsed.value),
          schemaValid: true,
          repairAttempts: poging,
          raw: laatsteRuw,
        };
      }
      laatsteFout = 'komt niet overeen met het schema';
    }

    throw new Error(`Vertex: schema niet gehaald na ${maxPogingen} pogingen — ${laatsteFout}`);
  }

  lastUsage(): LlmUsage {
    return this.usage;
  }

  private url(model: string, stream: boolean): string {
    const methode = stream ? 'streamRawPredict' : 'rawPredict';
    return (
      `https://${this.region}-aiplatform.googleapis.com/v1/projects/${this.options.projectId}` +
      `/locations/${this.region}/publishers/anthropic/models/${model}:${methode}`
    );
  }

  private async headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.accessToken()}`,
      'content-type': 'application/json',
    };
  }

  /**
   * Access token, met cache.
   *
   * Zonder cache zou elke beurt een extra round trip naar Google kosten — en dat is
   * precies de post die we met deze hele verhuizing proberen te verkleinen.
   */
  private async accessToken(): Promise<string> {
    const nu = Math.floor(Date.now() / 1000);
    if (this.token && this.token.verlooptOp - VERNIEUW_MARGE_S > nu) return this.token.waarde;

    const claim = {
      iss: this.options.clientEmail,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: nu,
      exp: nu + 3600,
    };
    const kop = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify(claim));
    const handtekening = createSign('RSA-SHA256')
      .update(`${kop}.${body}`)
      .sign(this.options.privateKey.replace(/\\n/g, '\n'));

    const assertion = `${kop}.${body}.${b64urlBytes(handtekening)}`;
    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Vertex: token mislukt, HTTP ${response.status} — ${detail.slice(0, 200)}`);
    }
    const uit = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!uit.access_token) throw new Error('Vertex: geen access_token in het antwoord');

    this.token = { waarde: uit.access_token, verlooptOp: nu + (uit.expires_in ?? 3600) };
    return this.token.waarde;
  }
}

function parseJson(tekst: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const schoon = tekst
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  try {
    return { ok: true, value: JSON.parse(schoon) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'ongeldige JSON' };
  }
}

const b64url = (value: string) => b64urlBytes(Buffer.from(value, 'utf8'));
const b64urlBytes = (bytes: Buffer) =>
  bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
