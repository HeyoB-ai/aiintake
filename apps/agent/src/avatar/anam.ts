import type { AvatarCapabilities, AvatarProvider } from '@intake/provider-avatar';

/**
 * Anam.
 *
 * **Belangrijk verschil met Beyond Presence, en het raakt de bakeoff.** Bey biedt een
 * LiveKit-transport: hun worker sluit aan op *onze* room, abonneert op onze audiotrack
 * en publiceert video terug. Alles gebeurt serverzijdig, en de meting kan vanuit Node.
 *
 * Anam werkt anders. `POST /v1/engine/session` levert een eigen engine-host, een eigen
 * WebSocket voor signalling en eigen ICE-servers:
 *
 *   engineHost         connect-eu.anam.ai/v1/webrtc/engines/anam-engine-...
 *   signallingEndpoint /v1/webrtc/engines/anam-engine-.../ws
 *   region             eu
 *
 * De verbinding wordt vervolgens opgezet door hun browser-SDK. Er is geen
 * server-transport waar wij een audiotrack in kunnen publiceren, dus de mediakant is
 * vanuit Node niet te bereiken zonder hun signallingprotocol na te bouwen bovenop een
 * WebRTC-stack.
 *
 * Wat dat betekent voor de bakeoff staat in docs/ADR-0010-bakeoff-harnas.md. Kort: de
 * twee providers zijn niet met hetzelfde harnas te meten, en het eerlijke antwoord is
 * beide in een browser meten in plaats van bey te bevoordelen met een Node-meting.
 *
 * Wat hier wél staat is het serverzijdige deel, en dat is precies wat een browserclient
 * nodig heeft: sessie aanmaken en een kortlevend sessietoken uitgeven. De API-key blijft
 * daarbij op de server, zoals het hoort.
 */

const API = 'https://api.anam.ai/v1';

/**
 * De "LLM" die geen LLM is: `GET /v1/llms` geeft hem als `displayName: "Disable LLM"`,
 * `llmFormat: "none"`, globaal beschikbaar. Dit is de enige stand waarin hun engine geen
 * eigen tekst produceert en dus ook hun TTS niet aanslaat.
 */
export const GEEN_LLM = 'CUSTOMER_CLIENT_V1';

export interface AnamOptions {
  readonly apiKey: string;
  /**
   * Persona-id (UUID) uit `GET /v1/personas`.
   *
   * **Dit is het enige veld dat de sessie bepaalt.** Een persona is een compleet profiel:
   * gezicht, stem, taal, systeemprompt en LLM in één. Een `avatarId` of `voiceId` in
   * dezelfde `personaConfig` meesturen doet niets — dat is gemeten en het kostte een
   * avond: met `personaId` van Anika en `avatarId` van Mia kwam Anika's gezicht in beeld
   * en begon ze in het Spaans. Hun API accepteert de extra velden met 200 en negeert ze.
   *
   * De stock-persona's zijn demo's met een eigen LLM en een eigen begroeting. Voor dit
   * product wil je een eigen persona met `llmId` op {@link GEEN_LLM}; zie
   * `scripts/anam-persona.mjs` en docs/anam-personas-en-avatars.md.
   */
  readonly personaId: string;
}

/** Wat er aan hun kant van een persona toe doet voor ons. */
export interface AnamPersona {
  readonly id: string;
  readonly naam: string;
  readonly gezicht: string;
  readonly llmId: string;
  readonly languageCode: string;
  readonly skipGreeting: boolean;
}

export interface AnamEngineSession {
  readonly sessionId: string;
  readonly engineHost: string;
  readonly signallingEndpoint: string;
  readonly region: string;
  readonly clientConfig: unknown;
}

export class AnamAvatarProvider implements AvatarProvider {
  readonly id = 'anam' as const;

  readonly capabilities: AvatarCapabilities = {
    audioPassthrough: true,
    textDriven: false,
    interrupt: true,
    idleMotion: true,
  };

  constructor(private readonly options: AnamOptions) {
    if (!options.personaId) {
      throw new Error(
        'Anam: zet ANAM_PERSONA_ID (uit GET /v1/personas). Een avatar-id werkt niet: de ' +
          'persona bepaalt gezicht, stem, taal én of hun eigen LLM meepraat.',
      );
    }
  }

  /** De configuratie die met het sessietoken meegaat. Eén veld, want meer doet niets. */
  private personaConfig(): Record<string, string> {
    return { personaId: this.options.personaId };
  }

  /** De persona zoals hij aan hún kant staat — niet zoals wij hem bedoeld hadden. */
  async fetchPersona(): Promise<AnamPersona> {
    const response = await fetch(`${API}/personas/${this.options.personaId}`, {
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
    if (!response.ok) {
      throw new Error(
        `Anam: persona ${this.options.personaId} niet op te halen, HTTP ${response.status}`,
      );
    }
    const p = (await response.json()) as {
      name?: string;
      avatar?: { displayName?: string };
      llmId?: string;
      languageCode?: string;
      skipGreeting?: boolean;
    };
    return {
      id: this.options.personaId,
      naam: p.name ?? '(naamloos)',
      gezicht: p.avatar?.displayName ?? '(onbekend)',
      llmId: p.llmId ?? '(geen)',
      languageCode: p.languageCode ?? '(geen)',
      skipGreeting: p.skipGreeting ?? false,
    };
  }

  /**
   * Weigeren zodra hun engine zelf zou gaan praten.
   *
   * Bij passthrough leveren wij de audio. Staat er een echte `llmId` op de persona, dan
   * begroet hun engine de cliënt met een eigen stem in de taal van de persona — gemeten:
   * op 1276 ms kwam er "¡Hola! Bienvenido" uit een Spaanse demo-persona, terwijl er van
   * ons nog niets was gestuurd. Twee stemmen in een intakegesprek is een productfout, en
   * hij is aan de configuratiekant onzichtbaar. Daarom hier, bij het opstarten.
   *
   * Het is bovendien een instelling die in hún dashboard te wijzigen is. Deze controle
   * draait dus elke start opnieuw en niet één keer bij het inrichten.
   */
  async assertStilBijPassthrough(): Promise<AnamPersona> {
    const persona = await this.fetchPersona();
    if (persona.llmId !== GEEN_LLM) {
      throw new Error(
        `Anam: persona "${persona.naam}" heeft llmId ${persona.llmId} en praat dus zelf ` +
          `mee. Bij passthrough leveren wij de audio; hun engine hoort stil te blijven. ` +
          `Gebruik een persona met llmId ${GEEN_LLM} ("Disable LLM"). Maak er een met ` +
          `pnpm --filter @intake/agent anam:persona.`,
      );
    }
    return persona;
  }

  /**
   * Kortlevend token voor de browser.
   *
   * Zelfde principe als het agent-sessietoken (ADR-0007): de langlevende API-key blijft
   * op de server, de client krijgt iets dat aan één sessie hangt.
   */
  async issueSessionToken(): Promise<string> {
    const response = await fetch(`${API}/auth/session-token`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      // `personaId`, niet `id`. Een token zonder persona wordt geaccepteerd door de API
      // maar door de SDK geweigerd als "legacy session token" — de fout valt dus pas in
      // de browser, ver van de plek waar hij is gemaakt.
      body: JSON.stringify({ personaConfig: this.personaConfig() }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `Anam: sessietoken mislukt, HTTP ${response.status} — ${detail.slice(0, 200)}`,
      );
    }
    const body = (await response.json()) as { sessionToken?: string };
    if (!body.sessionToken) throw new Error('Anam: geen sessionToken in het antwoord');
    return body.sessionToken;
  }

  /**
   * Beëindigt een lopende sessie vanaf de server.
   *
   * Dit is de enige betrouwbare manier om te stoppen met betalen. De browser kan het ook
   * via `stopStreaming()`, maar een tab die wordt weggeklikt krijgt geen kans meer om iets
   * asynchroons af te maken — gemeten blijft zo'n sessie dan **10 tot 20 seconden** open
   * tot hun engine hem zelf opruimt (`exitStatus: CLOSED_BY_ENGINE`). Dat zijn betaalde
   * minuten voor een gesprek dat niemand voert, en het is de verklaring voor de
   * gelijktijdigheidsfouten die we eerder zagen.
   *
   * De server heeft dat probleem niet: hij weet dat de socket dicht is.
   *
   * Niet te verwarren met `DELETE /v1/sessions/{id}`. Die verwijdert de *gegevens* en
   * geeft 409 zolang de sessie loopt ("Session data can only be deleted after the session
   * ends") — precies andersom dan wat je hier wilt.
   *
   * Geeft `true` als de sessie nu gesloten is. Gooit niet: afsluiten mag nooit de reden
   * zijn dat er iets anders omvalt.
   */
  async stopSession(sessionId: string): Promise<boolean> {
    try {
      const response = await fetch(`${API}/sessions/${sessionId}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Start een enginesessie en geeft terug waar de client naartoe moet verbinden. */
  async createEngineSession(): Promise<AnamEngineSession> {
    const response = await fetch(`${API}/engine/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ personaConfig: this.personaConfig() }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Anam: sessie mislukt, HTTP ${response.status} — ${detail.slice(0, 200)}`);
    }
    return (await response.json()) as AnamEngineSession;
  }

  /**
   * Niet geïmplementeerd, en bewust niet half.
   *
   * De `AvatarSession`-interface belooft `pushAudio` en `interrupt`. Die kan deze
   * provider vanuit Node niet waarmaken, want de mediastroom loopt via hun eigen
   * signalling naar een browserclient. Een implementatie die wél compileert maar geen
   * audio doorgeeft, zou de bakeoff stilzwijgend vervalsen: bey zou dan meetbaar zijn en
   * Anam onmeetbaar-maar-groen.
   *
   * Zie docs/ADR-0010-bakeoff-harnas.md voor de weg vooruit.
   */
  async createSession(): Promise<never> {
    throw new Error(
      'Anam heeft geen server-transport: de mediastroom loopt via hun browser-SDK. ' +
        'Gebruik issueSessionToken() en createEngineSession() vanuit apps/web. ' +
        'Zie docs/ADR-0010-bakeoff-harnas.md.',
    );
  }
}
