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
  /**
   * Persona-id (UUID) uit `GET /v1/personas`.
   *
   * Een persona is een kant-en-klaar profiel: gezicht, stem, taal en systeemprompt in één.
   * De stock-persona's zijn demo's ("Anika - Spanish Barista"), en voor een Nederlandse
   * arbeidsrecht-intake is dat zelden wat je wilt.
   */
  readonly personaId?: string;
  /**
   * Avatar-id (UUID) uit `GET /v1/avatars`. Alleen het gezicht.
   *
   * Dit is het pad dat je wilt voor dit product: wij leveren de stem via passthrough en
   * de taal komt uit ons eigen gesprek, dus van hun kant is alleen het gezicht nodig.
   *
   * Let op: een avatar-id is géén persona-id. Een avatar-UUID doorgeven als `personaId`
   * levert HTTP 400 "Persona not found or unavailable" — dat is gemeten, en het is de
   * reden dat deze twee als aparte velden bestaan in plaats van één "id".
   */
  readonly avatarId?: string;
  /**
   * Stem-id (UUID) uit `GET /v1/voices`.
   *
   * Verplicht zodra je een `avatarId` gebruikt: hun `CustomPersonaConfig` eist personaId,
   * name, avatarId én voiceId, alle vier. Een config met alleen een avatarId levert een
   * token op dat de API met 200 accepteert maar dat de signalling daarna weigert met
   * "HTTP Authentication failed" — dezelfde klasse fout als personaConfig.id destijds:
   * de melding valt in de browser, ver van de plek waar hij is gemaakt.
   *
   * Bij passthrough gebruiken wij deze stem niet; hij moet er alleen zijn.
   */
  readonly voiceId?: string;
  /** Naam van de deelnemer aan hun kant; alleen zichtbaar in hun logs. */
  readonly name?: string;
  readonly languageCode?: string;
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
    if (!options.avatarId && !options.personaId) {
      throw new Error(
        'Anam: geef ANAM_AVATAR_ID (uit GET /v1/avatars) of ANAM_PERSONA_ID (uit ' +
          'GET /v1/personas). Een avatar is alleen een gezicht; een persona is een ' +
          'kant-en-klaar profiel met stem en taal erbij.',
      );
    }
  }

  /**
   * De configuratie die met het sessietoken meegaat.
   *
   * Een avatar-id gaat als `avatarId` mee en niet als `personaId`; die twee zijn niet
   * uitwisselbaar. Staat er een avatar, dan wint die: bij passthrough leveren wij de stem
   * en komt de taal uit ons eigen gesprek, dus van hun kant is alleen het gezicht nodig.
   */
  private personaConfig(): Record<string, string> {
    if (!this.options.avatarId) return { personaId: this.options.personaId! };

    if (!this.options.personaId || !this.options.voiceId) {
      throw new Error(
        'Anam: een eigen avatar vraagt de volledige configuratie — personaId, avatarId ' +
          'en voiceId samen. Een config met alleen een avatarId geeft een token dat de ' +
          'API accepteert maar de signalling weigert. Zet ANAM_PERSONA_ID en ' +
          'ANAM_VOICE_ID erbij (GET /v1/personas en GET /v1/voices).',
      );
    }
    return {
      personaId: this.options.personaId,
      avatarId: this.options.avatarId,
      voiceId: this.options.voiceId,
      name: this.options.name ?? 'Intake',
      languageCode: this.options.languageCode ?? 'nl',
    };
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
