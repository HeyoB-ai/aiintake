import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { NullAvatarProvider } from '@intake/provider-avatar';
import type {
  AvatarCapabilities,
  AvatarEvents,
  AvatarProvider,
  AvatarSession,
  AvatarSessionOptions,
  TrackHandle,
} from '@intake/provider-avatar';
import { AnthropicLlmProvider } from '@intake/provider-llm';
import type { OrgConfig } from '@intake/domain';
import { IntakeSession } from '../src/intake-session';
import { mediaConfigFrom, startEchoSession } from '../src/echo-session';
import { formatHudLine } from '../src/metrics';
import type { AgentEnv } from '../src/env';

/**
 * Zelf tegen de intake praten, lokaal.
 *
 * Geen gezicht, geen LiveKit, geen database. Microfoon in de browser, dezelfde
 * mediaketen als in productie — Deepgram, de engine, Cartesia — en het geluid komt terug
 * over dezelfde WebSocket. De null-avatarprovider houdt de afspeelklok bij, zodat
 * barge-in en de transcripttruncatie zich gedragen zoals ze in productie doen.
 *
 * Bewust dezelfde `startEchoSession` als de echo-agent, met een andere `respond`. Twee
 * bedradingen zou betekenen dat de barge-in hier subtiel anders werkt dan daar, en dan
 * bewijst luisteren naar deze pagina niets over het product.
 *
 * Draaien met: pnpm dev:live
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const POORT = Number(process.env['LIVE_PORT'] ?? 5174);
const SAMPLE_RATE = 16_000;

/**
 * Rechtstreeks uit process.env, en niet via `readAgentEnv()`.
 *
 * Die leest de volledige agent-omgeving en eist onder meer de Supabase-variabelen. Deze
 * pagina praat niet met de database, dus hij hoort niet om te vallen als die configuratie
 * ontbreekt — dezelfde redenering als bij `mediaConfigFrom`, en de reden dat die functie
 * een `Partial` accepteert.
 */
const env = process.env as Partial<AgentEnv>;
const media = mediaConfigFrom(env);

if (!env.ANTHROPIC_API_KEY) {
  console.error(
    '\nANTHROPIC_API_KEY ontbreekt. Zonder model is er geen gesprek, alleen een echo.\n',
  );
  process.exit(1);
}

const ORG: OrgConfig = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Kantoor De Vries',
  slug: 'devries',
} as OrgConfig;

/**
 * De avatar die naar de browser praat.
 *
 * Hij delegeert alles aan de null-provider — inclusief de afspeelklok waarop `spokenMs`
 * en dus de transcripttruncatie rusten — en stuurt de audio bovendien de WebSocket in.
 * Zo hoor je precies wat de boekhouding denkt dat je hoort.
 */
function browserAvatar(inner: AvatarProvider, ws: WebSocket): AvatarProvider {
  return {
    id: inner.id,
    capabilities: inner.capabilities as AvatarCapabilities,
    async createSession(options: AvatarSessionOptions): Promise<AvatarSession> {
      const s = await inner.createSession(options);
      return {
        async pushAudio(pcm: Int16Array, seq: number) {
          if (ws.readyState === ws.OPEN) {
            ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          }
          await s.pushAudio(pcm, seq);
        },
        async interrupt() {
          // De browser moet zijn wachtrij weggooien, anders praat hij door nadat de
          // server allang is gestopt — en dan lijkt barge-in kapot terwijl hij werkt.
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'clear' }));
          return s.interrupt();
        },
        endTurn: () => s.endTurn?.(),
        videoTrack: () => s.videoTrack() as Promise<TrackHandle>,
        on: <E extends keyof AvatarEvents>(e: E, h: AvatarEvents[E]) => s.on(e, h),
        disconnect: () => s.disconnect(),
      };
    },
  };
}

const html = readFileSync(join(HIER, 'page.html'), 'utf8');
const server = createServer((req, res) => {
  if ((req.url ?? '/').startsWith('/health')) {
    res.writeHead(200).end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws) => {
  const stuur = (bericht: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(bericht));
  };

  const llm = new AnthropicLlmProvider({ apiKey: env.ANTHROPIC_API_KEY! });
  const intake = new IntakeSession({
    llm,
    organization: ORG,
    hotModel: env.LLM_HOT_MODEL ?? 'claude-haiku-4-5-20251001',
    coldModel: env.LLM_COLD_MODEL ?? 'claude-haiku-4-5-20251001',
  });

  let sessie: Awaited<ReturnType<typeof startEchoSession>> | null = null;
  let wilStarten = false;

  /**
   * De handlers vóór het opzetten van de sessie registreren.
   *
   * De browser stuurt `start` zodra de socket open is, en dat is honderden milliseconden
   * eerder dan het moment waarop Deepgram, Cartesia en de avatar er staan. Werd de
   * handler pas daarna gezet, dan verdween dat bericht en bleef het stil — zonder fout,
   * wat de vervelendste variant is.
   */
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!sessie) return; // audio van vóór de sessie heeft geen bestemming
      const buf = data as Buffer;
      sessie.pushAudio(new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2));
      return;
    }
    try {
      const bericht = JSON.parse(String(data)) as { type?: string };
      if (bericht.type !== 'start') return;
      if (sessie) void sessie.loop.open();
      else wilStarten = true;
    } catch {
      /* niet-JSON van de browser negeren we */
    }
  });

  ws.on('close', () => {
    void sessie?.close();
  });

  try {
    sessie = await startEchoSession({
      media,
      language: 'nl',
      respond: intake.responseSource(),
      avatarProvider: browserAvatar(new NullAvatarProvider(() => performance.now()), ws),
      onPrematureCut: (_volledig, gapMs) => stuur({ type: 'cut', gapMs }),
      onSkippedTurn: (reden) => stuur({ type: 'skipped', reden }),
      onTurnError: (error) => stuur({ type: 'error', waar: 'beurt', wat: String(error) }),
      onTurn: (turn) => {
        // De HUD-regel is dezelfde als in de worker-logs, inclusief de twee signalen
        // voor stil dataverlies.
        stuur({
          type: 'turn',
          client: turn.clientUtterance,
          assistant: turn.assistantContent,
          interrupted: turn.interruptedAtChar !== null,
          hud: formatHudLine(turn.metrics, {
            clientUtteranceWasCut: turn.clientUtteranceWasCut,
            rejectedFacts: 0,
          }),
        });

        // Het koude pad, ná de beurt en buiten de klok. Faalt het, dan raakt dat het
        // gesprek niet — daarom een losse catch en geen await op het spraakpad.
        intake.recordTurn(turn.clientUtterance, turn.assistantContent);
        void intake
          .observe()
          .then((r) => {
            stuur({
              type: 'facts',
              completeness: r.completeness,
              facts: Object.entries(intake.knownFacts()).map(([k, v]) => ({
                key: k,
                value: String(v?.value ?? '—'),
                status: v?.status,
              })),
              risks: r.riskFlags,
              rejected: r.rejectedFacts ?? [],
              ...(r.extractionError ? { extractionError: r.extractionError } : {}),
            });
          })
          .catch((error: unknown) => {
            stuur({ type: 'error', waar: 'cold path', wat: String(error) });
          });
      },
    });
  } catch (error) {
    stuur({ type: 'error', waar: 'opstarten', wat: String(error) });
    ws.close();
    return;
  }

  stuur({ type: 'ready' });
  if (wilStarten) void sessie.loop.open();
});

server.listen(POORT, () => {
  console.log(`\n  Praat met de intake:  http://localhost:${POORT}\n`);
  console.log(`  model ${env.LLM_HOT_MODEL ?? 'claude-haiku-4-5-20251001'} · ${SAMPLE_RATE} Hz`);
  console.log('  Stop met ctrl-c.\n');
});
