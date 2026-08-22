import { LATENCY_BUDGET_MS, type SessionMetric } from '@intake/domain';

/**
 * De latencybegroting per beurt.
 *
 * Zes stappen apart meten is geen boekhouding maar diagnose: bij een tegenvallende p50
 * wil je weten wélke stap eroverheen gaat. "Het gesprek voelt traag" is niet te
 * repareren; "endpointing zit op 480 ms" wel.
 *
 * De klok wordt geïnjecteerd zodat de metingen in tests exact reproduceerbaar zijn.
 */

export type TurnMetrics = Omit<SessionMetric, 'sessionId' | 'turnIndex'>;

export class TurnMetricsRecorder {
  private t0 = 0;
  private sttFinalAt: number | null = null;
  private firstTokenAt: number | null = null;
  private firstAudioAt: number | null = null;
  private firstFrameAt: number | null = null;
  private interruptAt: number | null = null;

  private metrics: TurnMetrics = empty();

  constructor(private readonly now: () => number) {}

  /**
   * De cliënt is uitgesproken. Hier begint de klok die de cliënt ervaart.
   *
   * `at` is het moment waarop het laatste woord eindigde, aangeleverd door de STT.
   * Zonder dat argument zou t0 het moment zijn waarop wíj het event kregen, en dan meet
   * `speechEndToSttFinalMs` de afstand tussen twee opeenvolgende regels code in plaats
   * van de endpointing-latency. Dat leverde metingen van 0,04 ms op — een getal dat er
   * goed uitziet en niets betekent.
   */
  speechEnd(at: number = this.now()): void {
    this.t0 = at;
    this.sttFinalAt = null;
    this.firstTokenAt = null;
    this.firstAudioAt = null;
    this.firstFrameAt = null;
    this.interruptAt = null;
    this.metrics = empty();
  }

  sttFinal(): void {
    this.sttFinalAt = this.now();
    this.metrics.speechEndToSttFinalMs = this.sttFinalAt - this.t0;
  }

  llmFirstToken(): void {
    if (this.firstTokenAt !== null) return;
    this.firstTokenAt = this.now();
    this.metrics.sttToLlmFirstTokenMs = this.firstTokenAt - (this.sttFinalAt ?? this.t0);
  }

  ttsFirstAudio(): void {
    if (this.firstAudioAt !== null) return;
    this.firstAudioAt = this.now();
    this.metrics.llmToTtsFirstAudioMs = this.firstAudioAt - (this.firstTokenAt ?? this.t0);
  }

  avatarFirstFrame(): void {
    if (this.firstFrameAt !== null) return;
    this.firstFrameAt = this.now();
    this.metrics.ttsToAvatarFirstFrameMs = this.firstFrameAt - (this.firstAudioAt ?? this.t0);
    // Dit is het getal dat telt: spraakeinde tot een sprekend gezicht.
    this.metrics.totalResponseLatencyMs = this.firstFrameAt - this.t0;
  }

  interruptRequested(): void {
    this.interruptAt = this.now();
    this.metrics.wasInterrupted = true;
  }

  /** Aanroepen zodra de TTS daadwerkelijk stil is. Budget: 50 ms. */
  silenceReached(): void {
    if (this.interruptAt === null) return;
    this.metrics.interruptToSilenceMs = this.now() - this.interruptAt;
  }

  snapshot(): TurnMetrics {
    return { ...this.metrics };
  }
}

function empty(): TurnMetrics {
  return {
    speechEndToSttFinalMs: null,
    sttToLlmFirstTokenMs: null,
    llmToTtsFirstAudioMs: null,
    ttsToAvatarFirstFrameMs: null,
    totalResponseLatencyMs: null,
    interruptToSilenceMs: null,
    wasInterrupted: false,
  };
}

// ------------------------------------------------------------------------ HUD

interface HudRow {
  readonly label: string;
  readonly value: number | null;
  readonly p50: number;
  readonly p95: number;
}

/**
 * De HUD-regels voor één beurt, met het budget ernaast.
 *
 * De client rendert dit als overlay in beeld (alleen buiten productie). Deze functie
 * levert de gegevens, niet de opmaak — dezelfde cijfers gaan ook naar `session_metrics`,
 * en die twee horen niet uit elkaar te lopen.
 */
export function hudRows(
  metrics: TurnMetrics,
): readonly (HudRow & { status: 'ok' | 'warn' | 'over' })[] {
  const budget = LATENCY_BUDGET_MS;
  const rows: HudRow[] = [
    { label: 'endpointing', value: metrics.speechEndToSttFinalMs, ...budget.endpointing },
    { label: 'llm first token', value: metrics.sttToLlmFirstTokenMs, ...budget.llmFirstToken },
    { label: 'tts first audio', value: metrics.llmToTtsFirstAudioMs, ...budget.ttsFirstAudio },
    {
      label: 'avatar first frame',
      value: metrics.ttsToAvatarFirstFrameMs,
      ...budget.avatarFirstFrame,
    },
    { label: 'totaal', value: metrics.totalResponseLatencyMs, ...budget.total },
  ];

  return rows.map((row) => ({
    ...row,
    status:
      row.value === null
        ? 'ok'
        : row.value <= row.p50
          ? 'ok'
          : row.value <= row.p95
            ? 'warn'
            : 'over',
  }));
}

/** Wat er per beurt naast de tijden vermeld moet worden. */
export interface HudExtras {
  /** Feiten die de citaatverankering weigerde omdat het citaat niet in de bron stond. */
  readonly rejectedFacts?: number;
  /** De STT kapte de cliënt af; zie RISICOS.md risico 2. */
  readonly clientUtteranceWasCut?: boolean;
}

/**
 * Eenregelige samenvatting voor de worker-logs. Bevat geen persoonsgegevens.
 *
 * De twee `extras` zijn geen sierlijkheden. Het zijn de enige twee plekken waar het
 * systeem stil data kan verliezen: de STT die een halve zin wegknipt, en het model dat
 * een feit verzint waarvan het citaat nergens staat. Een tijdenregel zonder die twee
 * ziet er groen uit terwijl er informatie ontbreekt.
 */
export function formatHudLine(metrics: TurnMetrics, extras: HudExtras = {}): string {
  const ms = (value: number | null) => (value === null ? '—' : `${value}ms`);
  const parts = [
    `eot ${ms(metrics.speechEndToSttFinalMs)}`,
    `llm ${ms(metrics.sttToLlmFirstTokenMs)}`,
    `tts ${ms(metrics.llmToTtsFirstAudioMs)}`,
    `frame ${ms(metrics.ttsToAvatarFirstFrameMs)}`,
    `totaal ${ms(metrics.totalResponseLatencyMs)}`,
  ];
  if (metrics.wasInterrupted)
    parts.push(`onderbroken, stil na ${ms(metrics.interruptToSilenceMs)}`);
  if (extras.clientUtteranceWasCut) parts.push('UITSPRAAK AFGEKAPT');
  if (extras.rejectedFacts) parts.push(`${extras.rejectedFacts} feit(en) GEWEIGERD`);
  return parts.join(' · ');
}

/** Haalt de Fase 1-poort: p50 onder 1,5 s. */
export function meetsPhaseOneGate(totals: readonly number[]): { p50: number; passes: boolean } {
  if (totals.length === 0) return { p50: Number.NaN, passes: false };
  const sorted = [...totals].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)]!;
  return { p50, passes: p50 < LATENCY_BUDGET_MS.gateFase1 };
}
