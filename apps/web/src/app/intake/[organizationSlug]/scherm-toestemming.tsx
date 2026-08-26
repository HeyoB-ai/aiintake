'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Camera, CameraOff, Mic, RefreshCw } from 'lucide-react';

/**
 * Scherm 2 — toestemming, apparaten en voorbeeld.
 *
 * ## Camera is optioneel, microfoon niet
 *
 * De intake moet volledig werken met alleen een microfoon. Dat is geen concessie maar een
 * eis: een cliënt die zijn camera niet aan wil of niet aan kán zetten, hoort het gesprek
 * gewoon te kunnen voeren. De cameraknop is daarom een schakelaar en geen voorwaarde, en
 * het voorbeeldvenster verdwijnt netjes als hij uit staat.
 *
 * ## Waarom de toestemming pas bij de knop wordt vastgelegd
 *
 * `getUserMedia` vraagt de browser om toegang; dat is iets anders dan de juridische
 * toestemming voor de verwerking. Die tweede wordt vastgelegd in `consent_records` mét de
 * versienummers van de twee verklaringen, en pas op het moment dat de cliënt op de knop
 * drukt. Zou hij worden vastgelegd zodra de browser toegang geeft, dan legt het dossier
 * een instemming vast die niemand heeft gegeven.
 *
 * ## iOS
 *
 * `getUserMedia` moet binnen een gebruikersgebaar. De knoppen hier zíjn dat gebaar, en de
 * verkregen stroom gaat ongewijzigd door naar het gespreksscherm — opnieuw opvragen daar
 * zou buiten het gebaar vallen en stil falen.
 */

export interface ToestemmingUitkomst {
  readonly privacy: boolean;
  readonly aiDisclosure: boolean;
  readonly camera: boolean;
  /** Verkregen binnen het gebruikersgebaar; gaat ongewijzigd door naar scherm 3. */
  readonly micStream: MediaStream;
  readonly naam: string;
  readonly email: string;
  readonly telefoon: string;
}

/**
 * Naam plus minstens één manier om terug te bellen.
 *
 * Waarom dit niet aan het gesprek wordt overgelaten: een naam is geen feit om via spraak op
 * te halen. Er valt niet op door te vragen, er is geen citaat dat hem staaft, en
 * spraakherkenning is op eigennamen juist het zwakst. Een verkeerd verstane achternaam in
 * een dossier is erger dan een lege kolom — hij ziet er ingevuld uit.
 *
 * Waarom hier en niet ná het gesprek: dit zijn de persoonsgegevens waarvoor op dit scherm
 * toestemming wordt gegeven. De cliënt hoort te zien wat hij afgeeft voordat hij akkoord
 * gaat, niet erna.
 *
 * Dezelfde regel staat in `create_public_intake`. Deze functie is het gemak; die is de
 * grens.
 */
export function contactCompleet(naam: string, email: string, telefoon: string): boolean {
  return naam.trim().length >= 2 && (email.trim() !== '' || telefoon.trim() !== '');
}

export interface ToestemmingProps {
  readonly organisatieNaam: string;
  readonly privacyVersie: string;
  readonly aiVersie: string;
  readonly bezig: boolean;
  readonly fout: string | null;
  readonly onTerug: () => void;
  readonly onAkkoord: (uitkomst: ToestemmingUitkomst) => void | Promise<void>;
}

/**
 * Waarom lukte het openen van de microfoon niet?
 *
 * Eén melding voor alle gevallen was: "De microfoon kon niet worden geopend." Die dekte
 * drie totaal verschillende oorzaken, en de meest voorkomende bij het testen op een toestel
 * — de pagina staat niet op HTTPS — zat er niet eens bij. Wie dat leest gaat in de
 * browserinstellingen zoeken naar een toestemming die het probleem niet is.
 */
export function verklaarMediaFout(error: unknown): string {
  const naam = error instanceof Error ? error.name : '';
  if (naam === 'NotAllowedError') {
    return (
      'De browser heeft de toegang geweigerd. Sta microfoon toe via het icoon in de ' +
      'adresbalk en probeer het opnieuw.'
    );
  }
  if (naam === 'NotFoundError' || naam === 'OverconstrainedError') {
    return 'Er is geen microfoon gevonden op dit apparaat.';
  }
  if (naam === 'NotReadableError') {
    return 'De microfoon is in gebruik door een ander programma. Sluit dat en probeer opnieuw.';
  }
  return 'De microfoon kon niet worden geopend.';
}

/**
 * Staat de pagina op een adres waar de browser media toestaat?
 *
 * `getUserMedia` bestaat alleen in een beveiligde context: HTTPS, of `localhost`. Op een
 * gewoon `http://192.168.x.x` — precies hoe je vanaf een telefoon test — weigert de browser.
 * Dat moet vóór de aanroep worden herkend, want er is geen eigen foutnaam voor: Safari
 * gooit `NotAllowedError` alsof de gebruiker heeft geweigerd, en Chrome laat
 * `navigator.mediaDevices` helemaal weg — dan is er niets om te vangen.
 */
export function onveiligeContext(): boolean {
  if (typeof window === 'undefined') return false;
  return !window.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function';
}

export function Toestemming({
  organisatieNaam,
  privacyVersie,
  aiVersie,
  bezig,
  fout,
  onTerug,
  onAkkoord,
}: ToestemmingProps) {
  const [privacy, setPrivacy] = useState(false);
  const [aiAkkoord, setAiAkkoord] = useState(false);
  const [camAan, setCamAan] = useState(false);
  const [toegang, setToegang] = useState<'nog-niet' | 'bezig' | 'gegeven' | 'geweigerd'>(
    'nog-niet',
  );
  const [naam, setNaam] = useState('');
  const [email, setEmail] = useState('');
  const [telefoon, setTelefoon] = useState('');
  const [toegangFout, setToegangFout] = useState<string | null>(null);
  const [apparaten, setApparaten] = useState<MediaDeviceInfo[]>([]);
  const [gekozenMic, setGekozenMic] = useState<string>('');
  const streamRef = useRef<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  /*
   * De stroom koppelen in een effect, niet meteen bij binnenkomst.
   *
   * Rechtstreeks aan `videoRef.current` hangen ging mis: het video-element bestaat alleen
   * als `camAan` waar is, en die stand werd pas ná het opvragen omgezet. De ref was dan nog
   * leeg en het voorbeeld bleef zwart. Een effect draait ná de render, dus daar staat het
   * element er wél.
   */
  const [stroomTeller, setStroomTeller] = useState(0);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = camAan ? streamRef.current : null;
  }, [camAan, stroomTeller, toegang]);

  const vraagToegang = useCallback(async (metCamera: boolean, micId?: string) => {
    setToegang('bezig');
    setToegangFout(null);

    // Vóór de aanroep: een onveilige context zou hieronder als "geweigerd" eindigen, en dat
    // stuurt iemand naar een browserinstelling die het probleem niet is.
    if (onveiligeContext()) {
      setToegang('geweigerd');
      setToegangFout(
        `Deze pagina staat op ${window.location.protocol}//${window.location.host}, en dat is ` +
          'geen beveiligde verbinding. Browsers geven alleen toegang tot de microfoon via ' +
          'HTTPS; localhost is de enige uitzondering. Open de pagina via https:// of via ' +
          'http://localhost:3000.',
      );
      return;
    }

    // Eerst de oude stroom sluiten: twee open streams op dezelfde camera laten het
    // lampje aan en geven op sommige telefoons een zwart beeld.
    for (const spoor of streamRef.current?.getTracks() ?? []) spoor.stop();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: micId ? { deviceId: { exact: micId } } : true,
        video: metCamera ? { facingMode: 'user' } : false,
      });
      streamRef.current = stream;
      setStroomTeller((n) => n + 1);
      setToegang('gegeven');

      /*
       * Apparaatnamen komen pas ná toestemming.
       *
       * `enumerateDevices` geeft daarvóór lege labels — dat is de browser die voorkomt
       * dat een site je hardware kan opsommen zonder te vragen. Dus pas hier de lijst
       * ophalen; eerder zou een keuzelijst met lege regels opleveren.
       */
      const lijst = await navigator.mediaDevices.enumerateDevices();
      const mics = lijst.filter((d) => d.kind === 'audioinput');
      setApparaten(mics);
      const actief = stream.getAudioTracks()[0]?.getSettings().deviceId;
      if (actief) setGekozenMic(actief);
    } catch (error) {
      setToegang('geweigerd');
      setToegangFout(verklaarMediaFout(error));
    }
  }, []);

  /*
   * Bewust géén opruiming bij unmount.
   *
   * Dit scherm verdwijnt in twee gevallen: de cliënt gaat terug, of het gesprek begint. In
   * het eerste geval sluit de Terug-knop de stroom; in het tweede is de stroom net
   * doorgegeven aan scherm 3 en zou hem hier sluiten precies de microfoon uitzetten die het
   * gesprek nodig heeft. Een `useEffect`-opruiming kan die twee niet uit elkaar houden,
   * dus staat de beslissing bij de knoppen.
   */

  const klaar =
    privacy && aiAkkoord && toegang === 'gegeven' && contactCompleet(naam, email, telefoon);

  return (
    <section className="flex flex-1 flex-col gap-5 py-4">
      <header>
        <h1 className="app-heading text-xl font-bold tracking-tight">Voordat we beginnen</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--app-text-muted)' }}>
          We hebben uw microfoon nodig. Camera mag, maar hoeft niet.
        </p>
      </header>

      {/* Apparaten en voorbeeld */}
      <div
        className="rounded-2xl border p-4"
        style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
      >
        {camAan && toegang === 'gegeven' ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="mb-3 aspect-video w-full -scale-x-100 rounded-xl bg-black object-cover"
          />
        ) : (
          <div
            className="mb-3 flex aspect-video w-full items-center justify-center rounded-xl text-sm"
            style={{ backgroundColor: 'var(--app-surface)', color: 'var(--app-text-dim)' }}
          >
            {camAan ? 'Camera wordt geopend…' : 'Camera staat uit'}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              // Eerst de stand omzetten, dan pas opvragen: het video-element bestaat alleen
              // als `camAan` waar is, en het effect hieronder kan er anders niets aan hangen.
              const wil = !camAan;
              setCamAan(wil);
              void vraagToegang(wil, gekozenMic || undefined);
            }}
            className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium"
            style={{
              backgroundColor: 'var(--app-card)',
              borderColor: 'var(--app-border)',
              color: 'var(--app-text)',
            }}
          >
            {camAan ? (
              <CameraOff className="h-4 w-4" aria-hidden />
            ) : (
              <Camera className="h-4 w-4" aria-hidden />
            )}
            {camAan ? 'Camera uit' : 'Camera aan'}
          </button>

          {toegang !== 'gegeven' && (
            <button
              type="button"
              onClick={() => void vraagToegang(camAan)}
              disabled={toegang === 'bezig'}
              className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold disabled:opacity-60"
              style={{
                backgroundColor: 'var(--app-primary)',
                color: 'var(--app-primary-text)',
              }}
            >
              <Mic className="h-4 w-4" aria-hidden />
              {toegang === 'bezig' ? 'Bezig…' : 'Microfoon toestaan'}
            </button>
          )}

          {toegang === 'geweigerd' && (
            <button
              type="button"
              onClick={() => void vraagToegang(camAan)}
              className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--app-border)', color: 'var(--app-text)' }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Opnieuw
            </button>
          )}
        </div>

        {apparaten.length > 1 && (
          <label className="mt-3 block text-sm">
            <span style={{ color: 'var(--app-text-muted)' }}>Microfoon</span>
            <select
              value={gekozenMic}
              onChange={(e) => {
                setGekozenMic(e.target.value);
                void vraagToegang(camAan, e.target.value);
              }}
              className="mt-1 w-full rounded-xl border px-3 py-2"
              style={{
                backgroundColor: 'var(--app-card)',
                borderColor: 'var(--app-border-strong)',
                color: 'var(--app-text)',
              }}
            >
              {apparaten.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || 'Microfoon'}
                </option>
              ))}
            </select>
          </label>
        )}

        {toegangFout && (
          <p
            className="mt-3 flex items-start gap-2 text-sm"
            style={{ color: 'var(--urgency-critical)' }}
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {toegangFout}
          </p>
        )}
      </div>

      {/*
       * De gegevens staan bóven de vinkjes, en dat is de hele reden dat ze hier staan.
       * Wie akkoord gaat met de privacyverklaring, heeft dan al gezien welke gegevens hij
       * afgeeft. Andersom zou het akkoord over iets abstracts gaan.
       */}
      <div
        className="rounded-2xl border p-4"
        style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
      >
        <h2 className="text-sm font-bold">Uw gegevens</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--app-text-muted)' }}>
          Zodat {organisatieNaam} u kan bereiken over uw zaak. Een e-mailadres of een telefoonnummer
          is genoeg — allebei mag ook.
        </p>

        <div className="mt-3 space-y-3">
          <Veld
            label="Naam"
            verplicht
            waarde={naam}
            opWijziging={setNaam}
            type="text"
            autoComplete="name"
            plaatshouder="Voor- en achternaam"
          />
          <Veld
            label="E-mailadres"
            waarde={email}
            opWijziging={setEmail}
            type="email"
            autoComplete="email"
            plaatshouder="naam@voorbeeld.nl"
          />
          <Veld
            label="Telefoonnummer"
            waarde={telefoon}
            opWijziging={setTelefoon}
            type="tel"
            autoComplete="tel"
            plaatshouder="06 12345678"
          />
        </div>

        {/*
         * Alleen tonen zodra er iets is ingevuld. Een rode regel boven een leeg formulier
         * leest als een fout die je al gemaakt hebt, terwijl je nog moet beginnen.
         */}
        {(naam !== '' || email !== '' || telefoon !== '') &&
          !contactCompleet(naam, email, telefoon) && (
            <p className="mt-3 text-sm" style={{ color: 'var(--app-text-muted)' }}>
              {naam.trim().length < 2
                ? 'Vul uw naam in.'
                : 'Vul een e-mailadres of een telefoonnummer in.'}
            </p>
          )}
      </div>

      {/* Twee aparte vinkjes: één akkoord voor beide zou geen van beide zijn. */}
      <div className="space-y-3">
        <Vinkje
          gemarkeerd={privacy}
          onWissel={() => setPrivacy((v) => !v)}
          label={
            <>
              Ik ga akkoord met de{' '}
              <a href="/privacy" className="underline" target="_blank" rel="noreferrer">
                privacyverklaring
              </a>{' '}
              van {organisatieNaam}{' '}
              <span style={{ color: 'var(--app-text-dim)' }}>(versie {privacyVersie})</span>
            </>
          }
        />
        <Vinkje
          gemarkeerd={aiAkkoord}
          onWissel={() => setAiAkkoord((v) => !v)}
          label={
            <>
              Ik begrijp dat ik met een <strong>AI-assistent</strong> spreek en niet met een
              advocaat, en dat er geen juridisch advies wordt gegeven{' '}
              <span style={{ color: 'var(--app-text-dim)' }}>(versie {aiVersie})</span>
            </>
          }
        />
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

      <div className="mt-auto flex flex-col gap-3 pt-2 sm:flex-row-reverse">
        <button
          type="button"
          disabled={!klaar || bezig}
          onClick={() => {
            const stream = streamRef.current;
            if (!stream) return;
            void onAkkoord({
              privacy,
              aiDisclosure: aiAkkoord,
              camera: camAan,
              micStream: stream,
              naam: naam.trim(),
              email: email.trim(),
              telefoon: telefoon.trim(),
            });
          }}
          className="rounded-xl px-5 py-3 text-base font-semibold shadow-sm transition-all active:scale-[0.98] disabled:opacity-50"
          style={{ backgroundColor: 'var(--app-primary)', color: 'var(--app-primary-text)' }}
        >
          {bezig ? 'Bezig…' : 'Gesprek beginnen'}
        </button>
        <button
          type="button"
          onClick={() => {
            for (const spoor of streamRef.current?.getTracks() ?? []) spoor.stop();
            streamRef.current = null;
            onTerug();
          }}
          className="rounded-xl border px-5 py-3 text-base font-medium"
          style={{
            backgroundColor: 'var(--app-card)',
            borderColor: 'var(--app-border)',
            color: 'var(--app-text)',
          }}
        >
          Terug
        </button>
      </div>
    </section>
  );
}

/**
 * Eén invoerveld.
 *
 * `type` en `autoComplete` staan er niet voor de netheid: op een telefoon bepaalt `type`
 * welk toetsenbord opengaat — `email` geeft een @, `tel` geeft cijfers — en `autoComplete`
 * bepaalt of de browser het adres kan invullen dat er al is. Dit scherm wordt op een
 * telefoon ingevuld door iemand die net heeft verteld dat hij ontslagen is; elk veld dat
 * hij zelf moet uittypen is een reden om af te haken.
 */
function Veld({
  label,
  waarde,
  opWijziging,
  type,
  autoComplete,
  plaatshouder,
  verplicht = false,
}: {
  label: string;
  waarde: string;
  opWijziging: (v: string) => void;
  type: 'text' | 'email' | 'tel';
  autoComplete: string;
  plaatshouder: string;
  verplicht?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span style={{ color: 'var(--app-text-muted)' }}>
        {label}
        {verplicht && <span aria-hidden> *</span>}
        {!verplicht && <span style={{ color: 'var(--app-text-dim)' }}> (optioneel)</span>}
      </span>
      <input
        type={type}
        value={waarde}
        required={verplicht}
        autoComplete={autoComplete}
        placeholder={plaatshouder}
        onChange={(e) => opWijziging(e.target.value)}
        // py-3: een aanraakzone van 44 px, de ondergrens waaronder tikken op een telefoon
        // gaat missen.
        className="mt-1 w-full rounded-xl border px-3 py-3"
        style={{
          backgroundColor: 'var(--app-card)',
          borderColor: 'var(--app-border-strong)',
          color: 'var(--app-text)',
        }}
      />
    </label>
  );
}

function Vinkje({
  gemarkeerd,
  onWissel,
  label,
}: {
  gemarkeerd: boolean;
  onWissel: () => void;
  label: React.ReactNode;
}) {
  return (
    <label
      className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm leading-relaxed"
      style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
    >
      <input
        type="checkbox"
        checked={gemarkeerd}
        onChange={onWissel}
        // Ruime aanraakzone: dit wordt op een telefoon aangetikt, niet aangeklikt.
        className="mt-0.5 h-5 w-5 shrink-0"
      />
      <span>{label}</span>
    </label>
  );
}
