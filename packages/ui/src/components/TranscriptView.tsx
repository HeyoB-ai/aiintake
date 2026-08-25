'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, MessageSquare, Send, User } from 'lucide-react';
import type { ConversationMessage } from '../types';

/**
 * Het transcript, ondergeschikt aan het beeld.
 *
 * ## Waarom dit geen chatvenster is
 *
 * De spec verbiedt dominante chatballonnen tijdens het gesprek: het kanaal is spraak, en
 * een chatvenster dat de aandacht trekt nodigt uit tot typen — dan voert de cliënt een
 * ander gesprek dan het gesprek dat gemeten en vastgelegd wordt.
 *
 * Daarom: platte regels met een sprekerlabel, geen ballonnen, geen kleurvlakken per beurt.
 * De cliëntbeurt krijgt hooguit een streepje links. Het prototype had daarnaast een rij
 * "snelle reacties" en een knop die een microfoonopname simuleerde met een vaste zin;
 * beide zijn hier weg — dat is testgereedschap dat in een cliëntscherm niet thuishoort.
 *
 * ## De hoogte staat op de berichtenlijst, niet op de buitenrand
 *
 * De wortel had `h-full`. Dat is `height: 100%`, en dat is alleen gedefinieerd tegen een
 * ouder met een *vaste* hoogte. De detailpagina gaf hem een ouder met alléén een
 * `max-height` — en daar lopen browsers uiteen: Chrome rekende het naar de inhoudshoogte en
 * alles paste, Safari niet, en dan tekende het transcript door zijn eigen doos heen. Het
 * auditlog begon op 640px en kreeg transcriptregels dwars door zijn eigen regels heen.
 *
 * Nu heeft de wortel geen hoogte en zit de begrenzing op de berichtenlijst zelf, mét
 * `overflow-y-auto` — dat knipt wél. Er is geen percentage meer om verkeerd op te lossen.
 *
 * ## Tekstinvoer
 *
 * Standaard uit. `allowTextInput` bestaat voor toegankelijkheid: iemand die niet kan of
 * wil spreken moet de intake toch kunnen doorlopen. Dat is een bewuste uitzondering, geen
 * tweede hoofdkanaal — vandaar dat hij expliciet aangezet moet worden.
 */

export interface TranscriptViewProps {
  readonly messages: readonly ConversationMessage[];
  readonly isAssistentBezig: boolean;
  /** Telemetrie per beurt. Nooit aan in het cliëntscherm. */
  readonly toonLatency?: boolean;
  readonly allowTextInput?: boolean;
  readonly onSendMessage?: (tekst: string) => void;
}

export function TranscriptView({
  messages,
  isAssistentBezig,
  toonLatency = false,
  allowTextInput = false,
  onSendMessage,
}: TranscriptViewProps) {
  const [invoer, setInvoer] = useState('');
  const eindeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    eindeRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isAssistentBezig]);

  const verstuur = (e: React.FormEvent): void => {
    e.preventDefault();
    const tekst = invoer.trim();
    if (!tekst || !onSendMessage) return;
    onSendMessage(tekst);
    setInvoer('');
  };

  return (
    <section
      className="flex flex-col overflow-hidden rounded-2xl border transition-colors"
      style={{
        backgroundColor: 'var(--app-card)',
        borderColor: 'var(--app-border)',
        boxShadow: 'var(--app-shadow)',
      }}
      aria-label="Transcript van het gesprek"
    >
      <header
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ backgroundColor: 'var(--app-surface)', borderColor: 'var(--app-border)' }}
      >
        <div className="flex items-center gap-2">
          <MessageSquare
            className="h-4 w-4"
            style={{ color: 'var(--app-text-muted)' }}
            aria-hidden
          />
          <h2
            className="text-xs font-bold uppercase tracking-wider"
            style={{ color: 'var(--app-text)' }}
          >
            Transcript
          </h2>
        </div>
        <span className="font-mono text-[11px]" style={{ color: 'var(--app-text-dim)' }}>
          {messages.length} {messages.length === 1 ? 'beurt' : 'beurten'}
        </span>
      </header>

      <div
        className="max-h-[60vh] min-h-[220px] flex-1 space-y-4 overflow-y-auto p-4 sm:p-5"
        aria-live="polite"
        aria-atomic="false"
      >
        {messages.length === 0 && !isAssistentBezig && (
          <p className="text-sm italic" style={{ color: 'var(--app-text-dim)' }}>
            Het gesprek verschijnt hier zodra het begint.
          </p>
        )}

        {messages.map((bericht) => (
          <article key={bericht.id} className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span
                className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
                style={{
                  color:
                    bericht.speaker === 'ASSISTENT'
                      ? 'var(--app-text-muted)'
                      : bericht.speaker === 'SYSTEEM'
                        ? 'var(--urgency-medium)'
                        : 'var(--app-primary)',
                }}
              >
                {bericht.speaker === 'ASSISTENT' ? (
                  <Bot className="h-3.5 w-3.5" aria-hidden />
                ) : bericht.speaker === 'U' ? (
                  <User className="h-3.5 w-3.5" aria-hidden />
                ) : null}
                {bericht.speaker}
              </span>
              <span className="font-mono text-[10px]" style={{ color: 'var(--app-text-dim)' }}>
                {bericht.timestamp}
              </span>
            </div>

            <p
              className="text-sm leading-relaxed sm:text-[15px]"
              style={{
                color: bericht.speaker === 'SYSTEEM' ? 'var(--app-text-muted)' : 'var(--app-text)',
                ...(bericht.speaker === 'U'
                  ? {
                      paddingLeft: '0.875rem',
                      borderLeft: '2px solid var(--app-primary)',
                      paddingTop: '0.125rem',
                      paddingBottom: '0.125rem',
                    }
                  : {}),
              }}
            >
              {bericht.text}
            </p>

            {toonLatency && bericht.latency && (
              <p className="font-mono text-[11px]" style={{ color: 'var(--app-text-dim)' }}>
                eot {bericht.latency.eot}ms · llm {bericht.latency.llm}ms · tts{' '}
                {bericht.latency.tts}ms · frame {bericht.latency.frame}ms · totaal{' '}
                {bericht.latency.totaal}ms · aanloop {bericht.latency.aanloop}ms
              </p>
            )}
          </article>
        ))}

        {isAssistentBezig && (
          <div className="space-y-1.5">
            <span
              className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
              style={{ color: 'var(--app-text-muted)' }}
            >
              <Bot className="h-3.5 w-3.5" aria-hidden />
              ASSISTENT
            </span>
            <div
              className="flex items-center gap-1.5 py-1"
              aria-label="De assistent formuleert een antwoord"
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-1.5 w-1.5 animate-bounce rounded-full"
                  style={{
                    backgroundColor: 'var(--app-text-dim)',
                    animationDelay: `${i * 0.15}s`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        <div ref={eindeRef} />
      </div>

      {allowTextInput && onSendMessage && (
        <form
          onSubmit={verstuur}
          className="flex items-center gap-2 border-t p-3"
          style={{ backgroundColor: 'var(--app-surface)', borderColor: 'var(--app-border)' }}
        >
          <label htmlFor="transcript-invoer" className="sr-only">
            Typ uw antwoord
          </label>
          <input
            id="transcript-invoer"
            type="text"
            value={invoer}
            onChange={(e) => setInvoer(e.target.value)}
            placeholder="Liever typen dan spreken? Typ hier uw antwoord."
            className="flex-1 rounded-xl border px-3.5 py-2.5 text-sm transition-colors focus:outline-none"
            style={{
              backgroundColor: 'var(--app-card)',
              borderColor: 'var(--app-border-strong)',
              color: 'var(--app-text)',
            }}
          />
          <button
            type="submit"
            disabled={!invoer.trim()}
            className="rounded-xl p-2.5 shadow-sm transition-all disabled:cursor-not-allowed"
            style={{
              backgroundColor: invoer.trim() ? 'var(--app-primary)' : 'var(--app-surface-subtle)',
              color: invoer.trim() ? 'var(--app-primary-text)' : 'var(--app-text-dim)',
              border: `1px solid ${invoer.trim() ? 'var(--app-primary)' : 'var(--app-border)'}`,
            }}
            title="Verstuur"
          >
            <Send className="h-4 w-4" aria-hidden />
          </button>
        </form>
      )}
    </section>
  );
}
