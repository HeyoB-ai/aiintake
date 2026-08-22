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

export interface AnamOptions {
  readonly apiKey: string;
  /** Persona-id (UUID). Bepaalt gezicht, stem en taal aan hun kant. */
  readonly personaId: string;
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

  constructor(private readonly options: AnamOptions) {}

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
      body: JSON.stringify({ personaConfig: { id: this.options.personaId } }),
    });

    if (!response.ok) {
      throw new Error(`Anam: sessietoken mislukt, HTTP ${response.status}`);
    }
    const body = (await response.json()) as { sessionToken?: string };
    if (!body.sessionToken) throw new Error('Anam: geen sessionToken in het antwoord');
    return body.sessionToken;
  }

  /** Start een enginesessie en geeft terug waar de client naartoe moet verbinden. */
  async createEngineSession(): Promise<AnamEngineSession> {
    const response = await fetch(`${API}/engine/session`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ personaConfig: { personaId: this.options.personaId } }),
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
