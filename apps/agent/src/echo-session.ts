import type { AvatarProvider } from '@intake/provider-avatar';
import { NullAvatarProvider } from '@intake/provider-avatar';
import { DeepgramSttProvider, keytermsFor } from '@intake/provider-stt';
import { maakTtsProvider, ttsConfigFrom, ttsKeuzeVan, type TtsConfig } from './tts-fabriek';
import type { Language } from '@intake/domain';
import type { AgentEnv } from './env';
import { log } from './log';
import { TurnLoop, type CompletedTurn, type ResponseSource } from './turn-loop';

/**
 * De echo-agent: de volledige realtime-lus met echte leveranciers, maar zonder model.
 *
 * Hij herhaalt wat de cliënt zei. Dat is opzet, geen tussenstap die we vergaten af te
 * maken. Fase 1 meet of de keten werkt — spraak in, gezicht dat praat, onderbreekbaar,
 * binnen het budget. Zat er een echt model in, dan zou je bij een tegenvallende meting
 * niet weten of het aan het transport ligt of aan de generatie. Het model komt in Fase 2,
 * op precies deze lus.
 */

/**
 * Alleen wat de mediaketen nodig heeft.
 *
 * Bewust niet de volledige `AgentEnv`: de echo-sessie praat niet met de database, dus
 * hij hoort ook niet om te vallen als de Supabase-configuratie ontbreekt. Een
 * afhankelijkheid die je niet gebruikt maar wel eist, maakt een component moeilijker te
 * testen zonder er iets voor terug te geven.
 */
export interface MediaConfig {
  readonly deepgramApiKey: string;
  readonly deepgramModel?: string;
  /**
   * Welke TTS, met welke sleutels.
   *
   * Hier stonden `cartesiaApiKey` en `cartesiaVoiceId` als veldnamen. Dat betekende dat de
   * leverancierskeuze in de vórm van dit type zat: een tweede leverancier toevoegen raakte
   * elk bestand dat die velden noemt. Zie tts-fabriek.ts.
   */
  readonly tts: TtsConfig;
}

/**
 * De mediaketen uit de omgeving.
 *
 * `keuzeUitOrganisatie` is `provider_config.tts` van het kantoor; laat hem weg en de keuze
 * komt uit `TTS_PROVIDER` of valt terug op ElevenLabs. `stemUitOrganisatie` is
 * `provider_config.ttsVoiceId`.
 */
export function mediaConfigFrom(
  env: Partial<AgentEnv>,
  keuzeUitOrganisatie?: string | null,
  stemUitOrganisatie?: string | null,
): MediaConfig {
  if (!env.DEEPGRAM_API_KEY) throw new Error('mediaketen onvolledig: DEEPGRAM_API_KEY');

  return {
    deepgramApiKey: env.DEEPGRAM_API_KEY,
    deepgramModel: env.DEEPGRAM_MODEL,
    tts: ttsConfigFrom(env, ttsKeuzeVan(env, keuzeUitOrganisatie), stemUitOrganisatie),
  };
}

export interface EchoSessionOptions {
  readonly media: MediaConfig;
  readonly language?: Language;
  /** Default is de null-provider: de lus draait volledig zonder avatarleverancier. */
  readonly avatarProvider?: AvatarProvider;
  /**
   * De bron van de antwoorden. Standaard de echo.
   *
   * Bestaat zodat dezelfde mediaketen — STT, TTS, avatar, barge-in — met de echte engine
   * gedraaid kan worden zonder dat er een tweede kopie van die bedrading ontstaat. Twee
   * bedradingen betekent twee plekken waar de barge-in subtiel anders werkt.
   */
  readonly respond?: ResponseSource;
  readonly onTurnError?: (error: unknown) => void;
  readonly onSkippedTurn?: (reason: string) => void;
  readonly onTurn?: (turn: CompletedTurn) => void;
  /** De STT kapte de cliënt af. Dataverlies-signaal; zie RISICOS.md risico 2. */
  readonly onPrematureCut?: (
    fullUtterance: string,
    gapMs: number,
    detectedBy: 'word_gap' | 'utterance_end',
  ) => void;
  readonly now?: () => number;
}

export interface EchoSession {
  readonly loop: TurnLoop;
  /** Audio van de cliënt erin. In de echte lus komt dit uit de LiveKit-room. */
  pushAudio(pcm: Int16Array): void;
  /** Vertelt de STT dat de audio op is; nodig bij het afspelen van een opname. */
  finaliseInput(): void;
  close(): Promise<void>;
}

/**
 * Het antwoord van de echo-agent.
 *
 * Twee zinnen, zodat de zinsflusher echt iets te doen heeft: één zin zou de hele
 * flush-logica onbenut laten en dan meet je hem ook niet.
 *
 * Na een barge-in wordt de eerste zin overgeslagen. De cliënt heeft die deels gehoord en
 * hem letterlijk herhalen is het duidelijkste "ik ben een machine"-signaal dat er is.
 */
export const echoResponse: ResponseSource = async function* (input) {
  if (input.interruptedPrefix) {
    yield 'Sorry, ga verder.';
    return;
  }
  yield `U zei: ${input.utterance}`;
  yield ' Klopt dat?';
};

export async function startEchoSession(options: EchoSessionOptions): Promise<EchoSession> {
  const { media } = options;
  const language = options.language ?? 'nl';
  const now = options.now ?? (() => performance.now());

  const stt = await new DeepgramSttProvider({
    apiKey: media.deepgramApiKey,
    ...(media.deepgramModel ? { model: media.deepgramModel } : {}),
  }).connect({ language, keyterms: keytermsFor(language) });

  // Welke leverancier dit is, staat in media.tts. TTS_TRIM_LEADING=0 zet het snijden van
  // aanloopstilte uit, voor beide, om het verschil te horen in plaats van te meten.
  const tts = await maakTtsProvider(media.tts).open({
    voiceId: media.tts.voiceId,
    language,
    sampleRate: media.tts.sampleRate,
  });

  const avatarProvider = options.avatarProvider ?? new NullAvatarProvider(now);
  const avatar = await avatarProvider.createSession({
    avatarId: null,
    language,
    roomName: null,
    // Dezelfde rate als de TTS levert. Stond hier niet, en de avatarlaag nam 16 kHz aan.
    sampleRate: media.tts.sampleRate,
  });

  const loop = new TurnLoop({
    stt,
    tts,
    avatar,
    language,
    now,
    respond: options.respond ?? echoResponse,
    onTurn: (turn) => options.onTurn?.(turn),
    onSkippedTurn: (reason) => {
      log.info('beurt overgeslagen', { reden: reason });
      options.onSkippedTurn?.(reason);
    },
    onTurnError: (error) => {
      log.error('beurt mislukt', { fout: String(error).slice(0, 200) });
      options.onTurnError?.(error);
    },
    onPrematureCut: (fullUtterance, gapMs, detectedBy) => {
      // Geen transcriptfragment in het log (§14) — alleen dát het gebeurde, hoe krap, en
      // welke detector hem ving.
      log.warn('uitspraak te vroeg afgekapt', {
        gapMs,
        detectedBy,
        tekens: fullUtterance.length,
      });
      options.onPrematureCut?.(fullUtterance, gapMs, detectedBy);
    },
  });

  // De cliënt begint te praten terwijl de assistent aan het woord is. Deepgram's
  // SpeechStarted is de autoritatieve trigger; de duur en de eerste partial bepalen
  // daarna of het een echte onderbreking is of een backchannel.
  let speechStartedAt = 0;
  stt.on('start_of_turn', () => {
    speechStartedAt = now();
    loop.duck();
  });
  stt.on('partial', (text) => {
    void loop.onClientSpeech({ speechMs: Math.round(now() - speechStartedAt), text });
  });

  return {
    loop,
    pushAudio: (pcm) => stt.push(pcm),
    finaliseInput: () => {
      // `finalise` bestaat alleen op de Deepgram-stream; bij een fake is het niet nodig.
      (stt as { finalise?: () => void }).finalise?.();
    },
    close: async () => {
      await Promise.allSettled([stt.close(), tts.close(), avatar.disconnect()]);
    },
  };
}
