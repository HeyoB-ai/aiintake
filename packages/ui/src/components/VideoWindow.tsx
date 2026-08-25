'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Maximize2,
  Mic,
  MicOff,
  Play,
  Radio,
  Square,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { SessieFasen } from '../types';

/**
 * Het videovenster van het gespreksscherm.
 *
 * ## Wat er anders is dan in het prototype
 *
 * Daar was het beeldvlak een Unsplash-foto van een kantoor met een pulserend vlekje eronder
 * als "spreekanimatie". Hier staat een echt `<video>`-element waaraan de avatarstream wordt
 * gehangen. Dat is geen detail: het prototype kon niet laten zien wanneer er géén beeld is,
 * en juist dat onderscheid kostte eerder een avond zoeken.
 *
 * Weggelaten om dezelfde reden: het badge "1080p • 60fps". Dat stond er ongeacht wat de
 * stream deed. Een scherm dat een resolutie meldt die het niet kent, is erger dan een
 * scherm dat niets meldt.
 *
 * De golfbalk onderin reageert op `niveau` (0..1) uit de echte audio. In het prototype
 * werd hij uit `Date.now()` in de render berekend, wat betekent dat hij alleen beweegt als
 * React toevallig hertekent — animatie die op toeval steunt.
 */

export interface VideoWindowProps {
  /** De mediastream van de avatar. `null` zolang er geen beeld is. */
  readonly stream: MediaStream | null;
  readonly sessionActive: boolean;
  readonly fasen: SessieFasen;
  readonly isAiSpeaking: boolean;
  readonly isUserSpeaking: boolean;
  /** Ingangsniveau 0..1 voor de golfbalk. */
  readonly niveau: number;
  readonly micEnabled: boolean;
  readonly soundEnabled: boolean;
  /** Loopduur van de sessie in seconden; avatarminuten zijn de duurste post. */
  readonly sessieSeconden: number;
  readonly onStartSession: () => void;
  readonly onStopSession: () => void;
  readonly onToggleMic: () => void;
  readonly onToggleSound: () => void;
}

const FASE_LABEL: Record<keyof Omit<SessieFasen, 'fout'>, string> = {
  sessie: 'sessie',
  verbonden: 'verbonden',
  eersteFrame: 'eerste frame',
};

/** Tien staafjes; het patroon bepaalt hoe de balk er in rust uitziet. */
const STAAFJES = [0.4, 0.75, 1, 0.6, 0.9, 0.45, 0.8, 0.5, 0.95, 0.3];

function klok(seconden: number): string {
  const m = Math.floor(seconden / 60);
  const s = Math.floor(seconden % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function VideoWindow({
  stream,
  sessionActive,
  fasen,
  isAiSpeaking,
  isUserSpeaking,
  niveau,
  micEnabled,
  soundEnabled,
  sessieSeconden,
  onStartSession,
  onStopSession,
  onToggleMic,
  onToggleSound,
}: VideoWindowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [volledigScherm, setVolledigScherm] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream;
    if (!stream) return;
    // Expliciet afspelen. Het element heeft `autoplay`, maar met een audiotrack erbij mag
    // een browser dat weigeren zonder gebruikersgebaar; de klik op Start dekt dat af.
    void el.play().catch(() => undefined);
  }, [stream]);

  useEffect(() => {
    const bij = (): void => setVolledigScherm(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', bij);
    return () => document.removeEventListener('fullscreenchange', bij);
  }, []);

  const wisselVolledigScherm = (): void => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen().catch(() => undefined);
  };

  const heeftBeeld = fasen.eersteFrame === 'klaar' && stream !== null;

  return (
    <div className="flex flex-col gap-3.5">
      <div
        ref={containerRef}
        className="group relative aspect-[16/10] w-full overflow-hidden rounded-2xl border transition-all sm:aspect-video"
        style={{
          backgroundColor: '#0a0a0a',
          borderColor: 'var(--app-border)',
          boxShadow: 'var(--app-shadow-lg)',
        }}
      >
        {/* Statusbalk bovenin */}
        <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold shadow-md backdrop-blur-md"
              style={{
                backgroundColor: 'rgb(0 0 0 / 75%)',
                color: 'var(--app-primary)',
                borderColor: 'var(--app-border)',
              }}
            >
              <span
                className={`h-2 w-2 rounded-full ${sessionActive ? 'animate-pulse' : ''}`}
                style={{
                  backgroundColor: sessionActive ? 'var(--app-primary)' : 'var(--app-text-dim)',
                }}
              />
              {sessionActive ? 'INTAKE ACTIEF' : 'STAND-BY'}
            </span>

            {isAiSpeaking && (
              <span
                className="flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wide shadow-sm backdrop-blur-md"
                style={{
                  backgroundColor: 'var(--app-accent-bg)',
                  color: 'var(--app-accent-text)',
                  borderColor: 'var(--app-accent-border)',
                }}
              >
                <Radio className="h-3 w-3 animate-pulse" aria-hidden />
                SPREEKT
              </span>
            )}

            {isUserSpeaking && (
              <span
                className="flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold tracking-wide shadow-sm backdrop-blur-md"
                style={{
                  backgroundColor: 'rgb(0 0 0 / 75%)',
                  color: 'var(--app-primary)',
                  borderColor: 'var(--app-border)',
                }}
              >
                <Activity className="h-3 w-3 animate-pulse" aria-hidden />
                LUISTERT
              </span>
            )}
          </div>

          {sessionActive && (
            <span
              className="rounded-full border px-2.5 py-0.5 font-mono text-[10px] shadow-md backdrop-blur-md"
              style={{
                backgroundColor: 'rgb(0 0 0 / 75%)',
                color: 'var(--app-text-dim)',
                borderColor: 'var(--app-border)',
              }}
              title="Duur van deze sessie"
            >
              {klok(sessieSeconden)}
            </span>
          )}
        </div>

        {/*
         * Het beeld zelf. Altijd gemonteerd, ook zonder stream: een element dat pas
         * verschijnt als er beeld is, maakt "geen beeld" onzichtbaar in plaats van
         * zichtbaar.
         */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={!soundEnabled}
          className="h-full w-full object-cover"
          style={{ opacity: heeftBeeld ? 1 : 0 }}
        />

        {!heeftBeeld && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex flex-wrap items-center justify-center gap-2">
              {(Object.keys(FASE_LABEL) as (keyof typeof FASE_LABEL)[]).map((sleutel) => {
                const stand = fasen[sleutel];
                return (
                  <span
                    key={sleutel}
                    className="rounded-full border px-2.5 py-0.5 text-[11px]"
                    style={{
                      borderColor:
                        stand === 'klaar'
                          ? 'var(--app-badge-green-border)'
                          : stand === 'fout'
                            ? 'var(--urgency-critical)'
                            : 'rgb(255 255 255 / 20%)',
                      color:
                        stand === 'klaar'
                          ? 'var(--app-badge-green-text)'
                          : stand === 'fout'
                            ? 'var(--urgency-critical)'
                            : 'rgb(255 255 255 / 55%)',
                      backgroundColor: stand === 'bezig' ? 'rgb(255 255 255 / 8%)' : 'transparent',
                    }}
                  >
                    {FASE_LABEL[sleutel]}
                    {stand === 'bezig' ? '…' : ''}
                  </span>
                );
              })}
            </div>
            {fasen.fout && (
              <p className="max-w-md text-xs" style={{ color: 'var(--urgency-critical)' }}>
                {fasen.fout}
              </p>
            )}
          </div>
        )}

        {/* Golfbalk en knoppen onderin */}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex items-center justify-between">
          <div
            className="flex items-center gap-1 rounded-full border px-2.5 py-1 backdrop-blur-md"
            style={{ backgroundColor: 'rgb(0 0 0 / 80%)', borderColor: 'rgb(255 255 255 / 15%)' }}
            aria-hidden
          >
            {STAAFJES.map((factor, i) => (
              <div
                key={i}
                className="w-0.5 rounded-full transition-[height] duration-100"
                style={{
                  backgroundColor: isAiSpeaking
                    ? 'var(--app-primary)'
                    : isUserSpeaking
                      ? 'var(--app-accent-text)'
                      : 'rgb(255 255 255 / 35%)',
                  height: `${Math.max(3, factor * niveau * 22)}px`,
                }}
              />
            ))}
          </div>

          <div
            className="pointer-events-auto flex items-center gap-1 rounded-lg border p-1 backdrop-blur-md"
            style={{ backgroundColor: 'rgb(0 0 0 / 80%)', borderColor: 'rgb(255 255 255 / 15%)' }}
          >
            <button
              type="button"
              onClick={wisselVolledigScherm}
              className="rounded p-1 text-slate-200 transition-colors hover:bg-white/15"
              title={volledigScherm ? 'Volledig scherm verlaten' : 'Volledig scherm'}
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* Bediening */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onStartSession}
          disabled={sessionActive}
          className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold shadow-sm transition-all enabled:hover:brightness-105 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            backgroundColor: sessionActive ? 'var(--app-surface)' : 'var(--app-badge-green-bg)',
            color: sessionActive ? 'var(--app-text-dim)' : 'var(--app-badge-green-text)',
            border: `1px solid ${sessionActive ? 'var(--app-border)' : 'var(--app-badge-green-border)'}`,
          }}
        >
          <Play className="h-4 w-4 fill-current" aria-hidden />
          Start gesprek
        </button>

        <button
          type="button"
          onClick={onStopSession}
          disabled={!sessionActive}
          className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all enabled:hover:opacity-90 enabled:active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            backgroundColor: 'var(--app-card)',
            color: 'var(--app-text)',
            border: '1px solid var(--app-border)',
          }}
        >
          <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
          Stop
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleMic}
            aria-pressed={!micEnabled}
            className="rounded-xl border p-2 shadow-sm transition-all"
            style={{
              backgroundColor: micEnabled ? 'var(--app-card)' : 'var(--urgency-critical-bg)',
              borderColor: micEnabled ? 'var(--app-border)' : 'var(--urgency-critical)',
              color: micEnabled ? 'var(--app-primary)' : 'var(--urgency-critical)',
            }}
            title={micEnabled ? 'Microfoon dempen' : 'Microfoon inschakelen'}
          >
            {micEnabled ? (
              <Mic className="h-4 w-4" aria-hidden />
            ) : (
              <MicOff className="h-4 w-4" aria-hidden />
            )}
          </button>

          <button
            type="button"
            onClick={onToggleSound}
            aria-pressed={!soundEnabled}
            className="rounded-xl border p-2 shadow-sm transition-all"
            style={{
              backgroundColor: soundEnabled ? 'var(--app-card)' : 'var(--urgency-critical-bg)',
              borderColor: soundEnabled ? 'var(--app-border)' : 'var(--urgency-critical)',
              color: soundEnabled ? 'var(--app-text)' : 'var(--urgency-critical)',
            }}
            title={soundEnabled ? 'Geluid dempen' : 'Geluid inschakelen'}
          >
            {soundEnabled ? (
              <Volume2 className="h-4 w-4" aria-hidden />
            ) : (
              <VolumeX className="h-4 w-4" aria-hidden />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
