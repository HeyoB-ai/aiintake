import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DocumentUploadSection,
  DocumentViewerModal,
  DossierSidebar,
  Header,
  ThemeProvider,
  ThemeSelector,
  TranscriptView,
  useTheme,
  VideoWindow,
  type DocumentItem,
} from '../src/index';
import {
  FIXTURE_BERICHTEN,
  FIXTURE_DOCUMENTEN,
  FIXTURE_DOSSIER,
  FIXTURE_FASEN_BEZIG,
  FIXTURE_FASEN_FOUT,
  FIXTURE_FASEN_KLAAR,
} from '../src/fixtures';

/**
 * Een etalage voor de componenten uit packages/ui.
 *
 * ## Wat dit wel en niet is
 *
 * Dit is géén applicatie. Er zit geen engine achter, geen transport en geen database: elk
 * component krijgt vaste waarden uit fixtures.ts en de knoppen doen niets buiten deze
 * pagina. Zo is te beoordelen hoe iets eruitziet zonder dat er ergens een tweede
 * gesprekslogica ontstaat die naast IntakeConversationEngine gaat leven.
 *
 * Om dezelfde reden staat hij niet als route in apps/web. Een pagina die in de echte
 * applicatie zit, is op een dag bereikbaar voor een cliënt.
 *
 * ## De videostream
 *
 * `VideoWindow` verwacht een echte `MediaStream`. Die maken we hier met een canvas, zodat
 * zichtbaar is dat het element werkelijk beeld toont in plaats van dat we een plaatje
 * neerzetten. Het is nadrukkelijk een testpatroon en geen avatar — het prototype waaruit
 * deze componenten komen zette daar een kantoorfoto neer, en dan lijkt een leeg venster
 * gevuld.
 */

/** Een bewegend testbeeld, zodat het video-element iets te doen heeft. */
function useTestStream(actief: boolean): MediaStream | null {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!actief) {
      setStream(null);
      return;
    }
    const canvas = canvasRef.current ?? document.createElement('canvas');
    canvasRef.current = canvas;
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    let id = 0;

    const teken = (): void => {
      if (ctx) {
        frame += 1;
        const t = frame / 60;
        const kleur = 120 + Math.sin(t) * 40;
        ctx.fillStyle = `rgb(${kleur * 0.3}, ${kleur * 0.35}, ${kleur * 0.45})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '20px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('synthetisch testbeeld — geen avatar', canvas.width / 2, canvas.height / 2);
        ctx.fillText(`frame ${frame}`, canvas.width / 2, canvas.height / 2 + 30);
      }
      id = requestAnimationFrame(teken);
    };
    teken();
    setStream(canvas.captureStream(30));
    return () => cancelAnimationFrame(id);
  }, [actief]);

  return stream;
}

function Blok({
  id,
  titel,
  toelichting,
  breed = false,
  children,
}: {
  /** Stabiel haakje voor de controle in preview.check.mjs; verandert niet met de tekst. */
  id: string;
  titel: string;
  toelichting?: string;
  breed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" data-blok={id}>
      <div>
        <h2
          className="app-heading text-sm font-bold uppercase tracking-wider"
          style={{ color: 'var(--app-text)' }}
        >
          {titel}
        </h2>
        {toelichting && (
          <p className="mt-0.5 text-xs" style={{ color: 'var(--app-text-muted)' }}>
            {toelichting}
          </p>
        )}
      </div>
      <div className={breed ? '' : 'max-w-[560px]'}>{children}</div>
    </section>
  );
}

function Etalage() {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<'intake' | 'documenten'>('intake');
  const [sessieActief, setSessieActief] = useState(false);
  const [seconden, setSeconden] = useState(0);
  const [mic, setMic] = useState(true);
  const [geluid, setGeluid] = useState(true);
  const [gekozenDoc, setGekozenDoc] = useState<DocumentItem | null>(null);
  const [documenten, setDocumenten] = useState<readonly DocumentItem[]>(FIXTURE_DOCUMENTEN);
  const stream = useTestStream(sessieActief);

  useEffect(() => {
    if (!sessieActief) {
      setSeconden(0);
      return;
    }
    const id = setInterval(() => setSeconden((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [sessieActief]);

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--app-bg)' }}>
      <Header
        orgName="Kantoor De Vries"
        fasen={sessieActief ? FIXTURE_FASEN_KLAAR : FIXTURE_FASEN_BEZIG}
        documentCount={documenten.length}
        activeTab={tab}
        onSelectTab={setTab}
        onResetSession={() => setSessieActief(false)}
        showThemeSelector
        currentTheme={theme}
        onSelectTheme={setTheme}
      />

      <main className="mx-auto max-w-[1700px] space-y-10 p-6">
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3.5"
          style={{
            backgroundColor: 'var(--app-accent-bg)',
            borderColor: 'var(--app-accent-border)',
            color: 'var(--app-accent-text)',
          }}
        >
          <p className="text-xs">
            Etalage voor <code>packages/ui</code>. Alle gegevens komen uit <code>fixtures.ts</code>;
            er zit geen engine achter en de knoppen doen niets buiten deze pagina.
          </p>
          <ThemeSelector currentTheme={theme} onSelectTheme={setTheme} />
        </div>

        <Blok
          id="video-standby"
          titel="VideoWindow — stand-by"
          toelichting="Zonder stream. De fasebalk laat zien waar het opzetten staat; er is met opzet geen plaatje dat een leeg venster gevuld laat lijken."
        >
          <VideoWindow
            stream={null}
            sessionActive={false}
            fasen={FIXTURE_FASEN_BEZIG}
            isAiSpeaking={false}
            isUserSpeaking={false}
            niveau={0}
            micEnabled
            soundEnabled
            sessieSeconden={0}
            onStartSession={() => undefined}
            onStopSession={() => undefined}
            onToggleMic={() => undefined}
            onToggleSound={() => undefined}
          />
        </Blok>

        <Blok
          id="video-actief"
          titel="VideoWindow — actief"
          toelichting="Start het gesprek om een synthetisch testbeeld te zien. Het is een canvas, geen avatar."
        >
          <VideoWindow
            stream={stream}
            sessionActive={sessieActief}
            fasen={sessieActief ? FIXTURE_FASEN_KLAAR : FIXTURE_FASEN_BEZIG}
            isAiSpeaking={sessieActief && seconden % 6 < 3}
            isUserSpeaking={sessieActief && seconden % 6 >= 3}
            niveau={sessieActief ? 0.4 + Math.abs(Math.sin(seconden)) * 0.6 : 0}
            micEnabled={mic}
            soundEnabled={geluid}
            sessieSeconden={seconden}
            onStartSession={() => setSessieActief(true)}
            onStopSession={() => setSessieActief(false)}
            onToggleMic={() => setMic((v) => !v)}
            onToggleSound={() => setGeluid((v) => !v)}
          />
        </Blok>

        <Blok
          id="video-fout"
          titel="VideoWindow — mislukte opzet"
          toelichting="Wat de cliënt ziet als de avatar niet opgezet kan worden."
        >
          <VideoWindow
            stream={null}
            sessionActive={false}
            fasen={FIXTURE_FASEN_FOUT}
            isAiSpeaking={false}
            isUserSpeaking={false}
            niveau={0}
            micEnabled
            soundEnabled
            sessieSeconden={0}
            onStartSession={() => undefined}
            onStopSession={() => undefined}
            onToggleMic={() => undefined}
            onToggleSound={() => undefined}
          />
        </Blok>

        <div className="grid gap-8 lg:grid-cols-2">
          <Blok
            id="transcript-client"
            titel="TranscriptView — cliëntscherm"
            toelichting="Zoals de cliënt hem ziet: geen ballonnen, geen telemetrie, geen tekstinvoer."
            breed
          >
            <TranscriptView messages={FIXTURE_BERICHTEN} isAssistentBezig />
          </Blok>

          <Blok
            id="transcript-dev"
            titel="TranscriptView — ontwikkelweergave"
            toelichting="Met telemetrie en met tekstinvoer voor wie niet kan of wil spreken."
            breed
          >
            <TranscriptView
              messages={FIXTURE_BERICHTEN}
              isAssistentBezig={false}
              toonLatency
              allowTextInput
              onSendMessage={() => undefined}
            />
          </Blok>
        </div>

        <Blok
          id="documenten"
          titel="DocumentUploadSection"
          toelichting="Drie toestanden naast elkaar: gelezen, nog bezig, mislukt. Er verschijnen geen feiten zolang de analyse loopt."
          breed
        >
          <DocumentUploadSection
            documents={documenten}
            onUploadFiles={() => undefined}
            onDeleteDocument={(id) => setDocumenten((d) => d.filter((x) => x.id !== id))}
            onSelectDocument={setGekozenDoc}
          />
        </Blok>

        <Blok
          id="dossier"
          titel="DossierSidebar — advocatendashboard"
          toelichting="Hoort níét in het cliëntscherm: urgentie tonen aan een cliënt is een juridische uitspraak. Let op de verplichte disclaimer boven de signalen."
          breed
        >
          <div className="grid gap-6 lg:grid-cols-2">
            <div
              className="rounded-2xl border"
              style={{ borderColor: 'var(--app-border)', overflow: 'hidden' }}
            >
              <DossierSidebar
                dossier={FIXTURE_DOSSIER}
                documents={documenten}
                onSelectDocument={setGekozenDoc}
                onExportDossier={() => undefined}
              />
            </div>
            <div
              className="rounded-2xl border"
              style={{ borderColor: 'var(--app-border)', overflow: 'hidden' }}
            >
              <DossierSidebar
                dossier={{ completeness: null, facts: [], riskFlags: [], rejected: [] }}
                documents={[]}
                onSelectDocument={setGekozenDoc}
                onExportDossier={() => undefined}
              />
            </div>
          </div>
        </Blok>

        <Blok id="modaal" titel="DocumentViewerModal" toelichting="Klik hierboven op “Bekijken”.">
          <button
            type="button"
            onClick={() => setGekozenDoc(FIXTURE_DOCUMENTEN[0] ?? null)}
            className="rounded-xl border px-3.5 py-2 text-sm font-semibold"
            style={{
              backgroundColor: 'var(--app-card)',
              borderColor: 'var(--app-border)',
              color: 'var(--app-text)',
            }}
          >
            Voorbeelddocument openen
          </button>
        </Blok>
      </main>

      <DocumentViewerModal document={gekozenDoc} onClose={() => setGekozenDoc(null)} />
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('geen #root in de pagina');
createRoot(root).render(
  <ThemeProvider>
    <Etalage />
  </ThemeProvider>,
);
