'use client';

import { useCallback, useRef, useState } from 'react';
import { Welkom } from './scherm-welkom';
import { Toestemming, type ToestemmingUitkomst } from './scherm-toestemming';
import { Gesprek } from './scherm-gesprek';
import type { ContactFout } from '@intake/domain';
import { startIntake } from './actions';

/**
 * De drie schermen, en de toestand die ertussen door moet.
 *
 * ## Waarom dit één component is
 *
 * De microfoonstroom uit scherm 2 gaat mee naar scherm 3. Die stroom is verkregen binnen
 * een gebruikersgebaar, en op iOS is dat de enige manier waarop hij bruikbaar is: een
 * navigatie ertussen breekt het gebaar én de stroom. Drie routes zouden er netter uitzien
 * en op een telefoon niet werken.
 *
 * ## Wat hier níét gebeurt
 *
 * Geen gesprekslogica. Die zit in `@intake/client`, hetzelfde bestand dat het
 * ontwikkelharnas gebruikt. Zou hier een tweede versie staan, dan werkt barge-in in het
 * product subtiel anders dan in het harnas waarin hij is afgesteld.
 */

type Stap = 'welkom' | 'toestemming' | 'gesprek' | 'afgerond';

export interface IntakeFlowProps {
  readonly organizationSlug: string;
  readonly organisatieNaam: string;
  readonly logoUrl: string | null;
  readonly privacyVersie: string;
  readonly aiVersie: string;
}

export function IntakeFlow(props: IntakeFlowProps) {
  const [stap, setStap] = useState<Stap>('welkom');
  const [fout, setFout] = useState<string | null>(null);
  /*
   * Een fout die aan één veld hangt, apart van de fout die in de balk hoort.
   *
   * De server valideert opnieuw — het formulier is geen grens — maar zijn weigering hoort net
   * zo goed onder het veld te staan als die van het formulier. Anders is er één weg waarop een
   * typefout er alsnog als storing uitziet.
   */
  const [veldFout, setVeldFout] = useState<ContactFout | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [bezig, setBezig] = useState(false);
  const micRef = useRef<MediaStream | null>(null);

  const opToestemming = useCallback(
    async (uitkomst: ToestemmingUitkomst) => {
      setBezig(true);
      setFout(null);
      setVeldFout(null);
      const antwoord = await startIntake({
        organizationSlug: props.organizationSlug,
        privacyAccepted: uitkomst.privacy,
        aiDisclosureAccepted: uitkomst.aiDisclosure,
        cameraConsent: uitkomst.camera,
        microphoneConsent: true,
        privacyPolicyVersion: props.privacyVersie,
        aiDisclosureVersion: props.aiVersie,
        clientName: uitkomst.naam,
        clientEmail: uitkomst.email,
        clientPhone: uitkomst.telefoon,
      });
      setBezig(false);

      if (!antwoord.ok) {
        // Een veldfout gaat naar het veld, de rest naar de balk. Nooit allebei: dan staat
        // dezelfde melding twee keer op het scherm.
        if (antwoord.veld) setVeldFout({ veld: antwoord.veld, melding: antwoord.fout });
        else setFout(antwoord.fout);
        // De stroom loslaten: blijft hij open, dan brandt het microfoonlampje terwijl er
        // geen gesprek is, en dat is precies het soort ding waar iemand terecht van
        // schrikt.
        for (const spoor of uitkomst.micStream.getTracks()) spoor.stop();
        return;
      }

      /*
       * Een https-pagina mag geen ws:// openen.
       *
       * Dat is gemengde inhoud, en de browser blokkeert het zonder dat de pagina er iets
       * van merkt: geen fout, geen event, alleen een verbinding die nooit opengaat. Op een
       * telefoon zie je dan een gespreksscherm dat blijft laden en heb je geen enkele
       * aanwijzing waaraan het ligt. Daarom hier hard stoppen met de reden erbij.
       *
       * Niet stilzwijgend opwaarderen naar wss://. Dat zou hier kloppen en in productie een
       * verkeerd geconfigureerd adres verbergen.
       */
      if (window.location.protocol === 'https:' && antwoord.wsUrl.startsWith('ws://')) {
        setFout(
          'De gespreksdienst staat op ws:// terwijl deze pagina op https draait. ' +
            'Browsers blokkeren die combinatie. Zet NEXT_PUBLIC_AGENT_WS_URL op wss:// ' +
            'en start de worker met pnpm dev:live:https.',
        );
        for (const spoor of uitkomst.micStream.getTracks()) spoor.stop();
        return;
      }

      micRef.current = uitkomst.micStream;
      setWsUrl(antwoord.wsUrl);
      setStap('gesprek');
    },
    [props.organizationSlug, props.privacyVersie, props.aiVersie],
  );

  return (
    <main
      className="mx-auto flex min-h-[100dvh] w-full max-w-3xl flex-col px-4 py-6 sm:px-6"
      style={{ background: 'var(--app-bg)', color: 'var(--app-text)' }}
    >
      {stap === 'welkom' && (
        <Welkom
          organisatieNaam={props.organisatieNaam}
          logoUrl={props.logoUrl}
          onStart={() => setStap('toestemming')}
        />
      )}

      {stap === 'toestemming' && (
        <Toestemming
          organisatieNaam={props.organisatieNaam}
          privacyVersie={props.privacyVersie}
          aiVersie={props.aiVersie}
          bezig={bezig}
          fout={fout}
          veldFoutVanServer={veldFout}
          onTerug={() => setStap('welkom')}
          onAkkoord={opToestemming}
        />
      )}

      {stap === 'gesprek' && wsUrl && micRef.current && (
        <Gesprek
          organisatieNaam={props.organisatieNaam}
          wsUrl={wsUrl}
          micStream={micRef.current}
          onAfgerond={() => setStap('afgerond')}
        />
      )}

      {stap === 'afgerond' && (
        <section className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <h1 className="text-xl font-semibold">Bedankt, het gesprek is afgerond.</h1>
          <p className="max-w-sm text-sm" style={{ color: 'var(--app-text-muted)' }}>
            Een advocaat van {props.organisatieNaam} bekijkt wat u heeft verteld en neemt contact
            met u op. U kunt dit venster sluiten.
          </p>
        </section>
      )}
    </main>
  );
}
