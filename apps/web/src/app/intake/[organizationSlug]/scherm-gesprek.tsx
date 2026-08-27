'use client';

import { useEffect, useRef, useState } from 'react';
import { ConversationClient, type Fase, type FaseStand } from '@intake/client';
import { Sparkles, Square, Upload } from 'lucide-react';

/**
 * Scherm 3 — het gesprek.
 *
 * ## Wat hier stond, en waarom het is veranderd
 *
 * Hier stond: "Geen chatballonnen, geen transcript. De spec verbiedt een dominante
 * tekstweergave tijdens het gesprek." Het argument erbij was goed en blijft gelden: een
 * meelopend transcript nodigt uit tot lezen en typen, en dan voert de cliënt een ander gesprek
 * dan het gesprek dat wordt opgenomen en beoordeeld.
 *
 * Dat argument gaat over een **dominante** tekstweergave. Wat er nu staat is dat niet: het
 * beeld blijft de hoofdzaak en de tekst staat eronder, in gedempte kleur, zonder invoerveld en
 * zonder ballonnen. Er is niets om op te typen.
 *
 * Wat het wél oplost, is een toegankelijkheidsgat. Wie slecht hoort, of wie het Nederlands niet
 * perfect beheerst, had geen weg terug als hij een vraag niet verstond — en dat is bij een
 * intake die juridisch wordt beoordeeld geen kleinigheid.
 *
 * ## De actuele vraag staat apart, en niet onderin het transcript
 *
 * Een scrollende lijst zet de nieuwste regel het verst van het beeld af. Wie de vraag niet
 * verstond, moet hem meteen kunnen lezen. Daarom staat de laatste assistentregel vast onder de
 * video, en komt hij pas in het transcript terecht zodra er een volgende beurt is. Zo staat
 * dezelfde zin nooit twee keer op het scherm.
 *
 * ## Voortgang: onderwerpen, geen percentage
 *
 * De worker stuurt `topicsTouched` en `topicsRelevant` mee. Bewust niet `completeness`: dat is
 * een gewogen score met een afkapping voor openstaande must-haves, en die als percentage tonen
 * suggereert een precisie die er niet is. "Drie van de zeven onderwerpen" is grof en klopt.
 *
 * De noemer kan tijdens het gesprek bewegen — of een categorie relevant is, hangt af van feiten
 * die nog moeten komen. Dat is geen bug om weg te verbergen; het is de reden om er geen
 * percentage van te maken.
 *
 * ## Geen dossierpaneel
 *
 * Nog steeds niet. Het `facts`-bericht van de worker draagt ook de gevonden waarden — salaris,
 * datums, werkgever — maar `ConversationClient` geeft alleen de tellers door. Die grens staat
 * in de client en niet hier, zodat dit scherm hem niet kán overschrijden.
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
 *
 * En het transcript: een scrollend vak onder de video is precies het geval waarin Safari op
 * iPhone eerder 202px overlap gaf. De oorzaak daar was `height: 100%` tegen een ouder met
 * `max-height` — iOS rekent die procenten uit tegen een hoogte die nog niet vaststaat. Hier
 * staat daarom **geen enkele procenthoogte**: het vak heeft een vaste `max-height` in pixels,
 * en elke flexkolom eronder heeft `min-h-0` zodat hij mag krimpen in plaats van zijn ouder uit
 * te rekken.
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

interface Regel {
  readonly wie: 'U' | 'Assistent';
  readonly tekst: string;
}

export function Gesprek({ organisatieNaam, wsUrl, micStream, onAfgerond }: GesprekProps) {
  const [toestand, setToestand] = useState<Toestand>('opzetten');
  const [fout, setFout] = useState<string | null>(null);
  const [niveau, setNiveau] = useState(0);
  const [regels, setRegels] = useState<Regel[]>([]);
  const [vraag, setVraag] = useState<string | null>(null);
  const [voortgang, setVoortgang] = useState<{ aangeraakt: number; relevant: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const selfRef = useRef<HTMLVideoElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<ConversationClient | null>(null);
  /*
   * De lopende vraag ook in een ref.
   *
   * `onBeurt` zit in een effect dat één keer draait. Leest hij `vraag` uit de state, dan leest
   * hij de waarde van de eerste render — en dan zakt er nooit iets het transcript in.
   */
  const vraagRef = useRef<string | null>(null);

  // De self-view is lokaal en gaat nergens heen. Dat is geen implementatiedetail maar
  // ADR-0004: er staat letterlijk geen cliëntvideo op enige server.
  useEffect(() => {
    if (selfRef.current) selfRef.current.srcObject = micStream;
  }, [micStream]);

  /*
   * Meescrollen, maar alleen als de lezer onderaan stond.
   *
   * Wie terugbladert om een eerdere vraag na te lezen, wordt anders bij elke nieuwe beurt
   * weggesprongen — precies op het moment dat hij iets aan het lezen is.
   */
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const stondOnderaan = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (stondOnderaan) el.scrollTop = el.scrollHeight;
  }, [regels]);

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
      onBeurt: (beurt) => {
        if (!levend) return;
        /*
         * De vorige vraag zakt het transcript in, de nieuwe komt bovenaan te staan.
         *
         * `hud` blijft waar hij is: die is voor ontwikkelweergaven en nooit voor de cliënt.
         */
        setRegels((eerder) => {
          const erbij: Regel[] = [];
          if (vraagRef.current) erbij.push({ wie: 'Assistent', tekst: vraagRef.current });
          if (beurt.client.trim()) erbij.push({ wie: 'U', tekst: beurt.client.trim() });
          return erbij.length > 0 ? [...eerder, ...erbij] : eerder;
        });
        const nieuw = beurt.assistant.trim();
        vraagRef.current = nieuw || null;
        setVraag(nieuw || null);
      },
      onVoortgang: (aangeraakt, relevant) => {
        if (levend && relevant > 0) setVoortgang({ aangeraakt, relevant });
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
    // `min-h-0` op de kolom: zonder dat mag een scrollend kind zijn ouder uitrekken in plaats
    // van zelf te krimpen, en dan schuift de knoppenrij van het scherm af.
    <section className="flex min-h-0 flex-1 flex-col gap-3 py-2">
      {/* Het beeld, groot en centraal. */}
      <div
        className="relative aspect-[3/4] w-full shrink-0 overflow-hidden rounded-xl border sm:aspect-video"
        style={{ backgroundColor: '#0a0a0a', borderColor: 'var(--app-border)' }}
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

      {
        /*
         * Voortgang: één dunne lijn en één regel tekst.
         *
         * `aria-hidden` op de balk en de telling als tekst ernaast: een schermlezer heeft aan
         * "drie van de zeven onderwerpen besproken" genoeg en niets aan een gevuld vlak.
         */
        voortgang && (
          <div className="flex shrink-0 items-center gap-3">
            <span
              className="block h-px flex-1"
              style={{ backgroundColor: 'var(--app-border)' }}
              aria-hidden
            >
              <span
                className="block h-px transition-all"
                style={{
                  width: `${Math.round((voortgang.aangeraakt / voortgang.relevant) * 100)}%`,
                  backgroundColor: 'var(--app-text-muted)',
                }}
              />
            </span>
            <span className="text-xs tabular-nums" style={{ color: 'var(--app-text-muted)' }}>
              {voortgang.aangeraakt} van {voortgang.relevant} onderwerpen besproken
            </span>
          </div>
        )
      }

      {/* De actuele vraag, vast onder het beeld. */}
      {vraag && (
        <p className="shrink-0 text-base leading-relaxed" style={{ color: 'var(--app-text)' }}>
          {vraag}
        </p>
      )}

      {
        /*
         * Het transcript.
         *
         * `max-h` in pixels en niet in procenten: zie de toelichting over iOS bovenaan dit
         * bestand. `min-h-0` zodat het vak mag krimpen op een kort scherm.
         */
        regels.length > 0 && (
          <div
            ref={transcriptRef}
            className="min-h-0 max-h-[220px] overflow-y-auto border-t pt-3"
            style={{ borderColor: 'var(--app-border)' }}
            aria-label="Wat er tot nu toe is gezegd"
          >
            <dl className="flex flex-col gap-2 text-sm leading-relaxed">
              {regels.map((r, i) => (
                // De index als sleutel: regels worden alleen achteraan toegevoegd, nooit
                // ingevoegd of herordend, dus hij is hier stabiel.
                <div key={i} className="flex gap-3">
                  <dt
                    className="w-16 shrink-0 text-xs uppercase tracking-wide"
                    style={{ color: 'var(--app-text-muted)' }}
                  >
                    {r.wie}
                  </dt>
                  <dd style={{ color: 'var(--app-text-muted)' }}>{r.tekst}</dd>
                </div>
              ))}
            </dl>
          </div>
        )
      }

      {fout && (
        <p
          className="shrink-0 rounded-xl border px-3 py-2 text-sm"
          style={{
            backgroundColor: 'var(--urgency-critical-bg)',
            borderColor: 'var(--urgency-critical)',
            color: 'var(--urgency-critical)',
          }}
        >
          {fout}
        </p>
      )}

      <div className="mt-auto flex shrink-0 flex-col gap-3 pt-1 sm:flex-row">
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
