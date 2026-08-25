'use client';

import { useEffect, useRef, useState } from 'react';
import { ConversationClient, type Fase, type FaseStand } from '@intake/client';
import { Sparkles, Square, Upload } from 'lucide-react';

/**
 * Scherm 3 — het gesprek.
 *
 * ## Beeld is de hoofdzaak, tekst niet
 *
 * Geen chatballonnen, geen transcript. De spec verbiedt een dominante tekstweergave tijdens
 * het gesprek, en de reden is niet esthetisch: een meelopend transcript nodigt uit tot
 * lezen en typen, en dan voert de cliënt een ander gesprek dan het gesprek dat wordt
 * opgenomen en beoordeeld. Wat er wél staat is één regel status — luistert, denkt, spreekt
 * — zodat stilte niet als storing voelt.
 *
 * Geen dossierpaneel. Urgentie en volledigheid zijn het scherm van de advocaat; ze aan de
 * cliënt tonen zou een juridische uitspraak zijn.
 *
 * ## Het AI-label blijft staan
 *
 * Niet één keer bij het begin, maar permanent in beeld. Iemand die halverwege binnenkomt of
 * even wegkijkt, moet het opnieuw kunnen zien.
 *
 * ## iOS
 *
 * De self-view is `muted` en `playsinline`. Zonder `playsinline` neemt Safari het video-
 * element over in volledig scherm zodra het speelt; zonder `muted` weigert het autoplay.
 * De avatarvideo mag níét `muted` zijn — daar komt het geluid uit — en die start dan ook
 * expliciet vanuit de klik in het vorige scherm.
 */

export interface GesprekProps {
  readonly organisatieNaam: string;
  readonly wsUrl: string;
  readonly micStream: MediaStream;
  readonly onAfgerond: () => void;
}

type Toestand = 'opzetten' | 'luistert' | 'denkt' | 'spreekt' | 'fout';

const TOESTAND_TEKST: Record<Toestand, string> = {
  opzetten: 'Een moment, we zetten het gesprek op…',
  luistert: 'Ik luister',
  denkt: 'Een moment…',
  spreekt: 'Aan het woord',
  fout: 'Er ging iets mis',
};

export function Gesprek({ organisatieNaam, wsUrl, micStream, onAfgerond }: GesprekProps) {
  const [toestand, setToestand] = useState<Toestand>('opzetten');
  const [fout, setFout] = useState<string | null>(null);
  const [niveau, setNiveau] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selfRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<ConversationClient | null>(null);

  // De self-view is lokaal en gaat nergens heen. Dat is geen implementatiedetail maar
  // ADR-0004: er staat letterlijk geen cliëntvideo op enige server.
  useEffect(() => {
    if (selfRef.current) selfRef.current.srcObject = micStream;
  }, [micStream]);

  useEffect(() => {
    let levend = true;
    let client: ConversationClient | null = null;

    void ConversationClient.start({
      wsUrl,
      micStream,
      videoElement: videoRef.current,
      /*
       * De SDK van een CDN, en via een variabele.
       *
       * De URL in een variabele zetten houdt de bundler én TypeScript ervan af hem te
       * willen oplossen; dit is een runtime-import van een script dat niet in onze
       * afhankelijkheden zit. Dat is met opzet: de avatar-SDK hoort niet in de bundel die
       * een cliënt op een telefoon binnenhaalt voordat hij weet of er een gezicht komt.
       */
      laadAnamSdk: async () => {
        const bron = 'https://esm.sh/@anam-ai/js-sdk@4';
        const mod = (await import(/* webpackIgnore: true */ bron)) as {
          createClient: (t: string) => never;
        };
        return mod;
      },
      onFase: (fase: Fase, stand: FaseStand, melding?: string) => {
        if (stand === 'fout') {
          setToestand('fout');
          setFout(melding ?? `Het opzetten liep vast bij: ${fase}.`);
        }
      },
      onSpreekt: (wie) => {
        if (!levend) return;
        setToestand(wie === 'assistent' ? 'spreekt' : wie === 'cliënt' ? 'luistert' : 'denkt');
      },
      onNiveau: (n) => levend && setNiveau(n),
      onFout: (waar, wat) => {
        if (!levend) return;
        setToestand('fout');
        setFout(`${waar}: ${wat}`);
      },
      onGestopt: () => levend && onAfgerond(),
    })
      .then((c) => {
        client = c;
        clientRef.current = c;
        if (levend) setToestand('luistert');
        // De aanroeper is al gestopt terwijl wij nog opzetten: dan meteen weer sluiten,
        // anders blijft er een betaalde sessie draaien die niemand ziet.
        if (!levend) c.stop('scherm verlaten tijdens het opzetten');
      })
      .catch((error: unknown) => {
        if (!levend) return;
        setToestand('fout');
        setFout(error instanceof Error ? error.message : String(error));
      });

    return () => {
      levend = false;
      client?.stop('scherm verlaten');
    };
  }, [wsUrl, micStream, onAfgerond]);

  return (
    <section className="flex flex-1 flex-col gap-4 py-2">
      {/* Het beeld, groot en centraal. */}
      <div
        className="relative aspect-[3/4] w-full overflow-hidden rounded-2xl sm:aspect-video"
        style={{ backgroundColor: '#0a0a0a' }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          className="h-full w-full object-cover"
          aria-label={`AI-intake-assistent van ${organisatieNaam}`}
        />

        {/* Permanent AI-label. */}
        <span
          className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold backdrop-blur-md"
          style={{
            backgroundColor: 'rgb(0 0 0 / 65%)',
            borderColor: 'rgb(255 255 255 / 25%)',
            color: '#ffffff',
          }}
        >
          <Sparkles className="h-3 w-3" aria-hidden />
          AI-assistent — geen advocaat
        </span>

        {/* Self-view, klein en lokaal. */}
        <video
          ref={selfRef}
          autoPlay
          playsInline
          muted
          className="absolute right-3 top-3 h-24 w-16 -scale-x-100 rounded-lg border object-cover sm:h-28 sm:w-20"
          style={{ borderColor: 'rgb(255 255 255 / 25%)', backgroundColor: '#000' }}
          aria-label="Uw eigen beeld; dit verlaat uw apparaat niet"
        />

        {toestand !== 'spreekt' && (
          <span
            className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 px-4 py-3 text-sm"
            style={{ background: 'linear-gradient(transparent, rgb(0 0 0 / 70%))', color: '#fff' }}
          >
            <span
              className="h-1.5 rounded-full transition-all"
              style={{
                width: `${8 + niveau * 40}px`,
                backgroundColor: toestand === 'luistert' ? '#7ee2a8' : 'rgb(255 255 255 / 45%)',
              }}
              aria-hidden
            />
            {TOESTAND_TEKST[toestand]}
          </span>
        )}
      </div>

      {fout && (
        <p
          className="rounded-xl border px-3 py-2 text-sm"
          style={{
            backgroundColor: 'var(--urgency-critical-bg)',
            borderColor: 'var(--urgency-critical)',
            color: 'var(--urgency-critical)',
          }}
        >
          {fout}
        </p>
      )}

      <div className="mt-auto flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled
          title="Documenten uploaden komt in de volgende stap"
          className="flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-base font-medium disabled:opacity-50"
          style={{
            backgroundColor: 'var(--app-card)',
            borderColor: 'var(--app-border)',
            color: 'var(--app-text)',
          }}
        >
          <Upload className="h-4 w-4" aria-hidden />
          Document uploaden
        </button>
        <button
          type="button"
          onClick={() => clientRef.current?.stop('door de cliënt beëindigd')}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-3 text-base font-semibold"
          style={{
            backgroundColor: 'var(--urgency-critical-bg)',
            color: 'var(--urgency-critical)',
            border: '1px solid var(--urgency-critical)',
          }}
        >
          <Square className="h-4 w-4 fill-current" aria-hidden />
          Gesprek beëindigen
        </button>
      </div>
    </section>
  );
}
