import {
  CartesiaTtsProvider,
  ElevenLabsTtsProvider,
  FakeTtsProvider,
  type TextToSpeechProvider,
} from '@intake/provider-tts';
import type { AgentEnv } from './env';

/**
 * Welke TTS draait er, en met welke sleutels?
 *
 * ## Waarom deze laag er is
 *
 * `startEchoSession` construeerde `new CartesiaTtsProvider(...)` rechtstreeks, en
 * `MediaConfig` droeg `cartesiaApiKey` en `cartesiaVoiceId` als **veldnamen**. De keuze zat
 * daarmee niet in een parameter maar in de vorm van het configuratietype: een tweede
 * leverancier toevoegen betekende elk bestand aanpassen dat die velden noemt.
 *
 * Bij de avatars is dat wél goed opgelost — `EchoSessionOptions.avatarProvider` wordt
 * ingespoten en valt terug op de null-provider. Dit bestand is dezelfde naad voor de TTS.
 *
 * ## De schakelaar bestond al
 *
 * `ProviderConfigSchema.tts` is `'cartesia' | 'elevenlabs' | 'fake'`, wordt geseed en gaat via
 * `agent_set_session_providers` de database in. Niemand las hem uit — dezelfde vorm als de
 * zeven ongebruikte agent-RPC's (risico 15). Nu leest deze fabriek hem.
 *
 * ## Waarom ElevenLabs de standaard is
 *
 * Gemeten met `pnpm diag:tts-vergelijk`, negen metingen per leverancier op de openingszin:
 *
 *                                      Cartesia  ElevenLabs
 *   "Goedenavond" volledig weg            7/9       0/9
 *   "geen advocaat" weg of verminkt       1/9       0/9
 *   herhaalde reeks van 3+ woorden        2/9       0/9
 *
 * De tweede regel gaf de doorslag: Cartesia leverde "ik ben advocaat en ben aangesteld om…".
 * De disclaimer zegt dan het tegenovergestelde van wat er staat, in een gesprek waarin de
 * cliënt precies voor die zin heeft getekend. Eerste audio scheelt 8 ms, dus daar zit de
 * afweging niet.
 *
 * Cartesia blijft werkend en niet als dood pad: `provider_config.tts` op `'cartesia'` zetten
 * is genoeg, en `TTS_PROVIDER` overrulet dat voor een losse proef. De vergelijking moet te
 * herhalen zijn.
 */

export type TtsKeuze = 'cartesia' | 'elevenlabs' | 'fake';

/**
 * Alles wat één leverancier nodig heeft, zonder leveranciersnaam in een veldnaam.
 *
 * `voiceId` en niet `cartesiaVoiceId`: welke stem het is, hangt van `keuze` af, en het type
 * hoort daar niets over te beweren.
 */
export interface TtsConfig {
  readonly keuze: TtsKeuze;
  readonly apiKey: string;
  readonly voiceId: string;
  readonly model?: string;
  readonly sampleRate: number;
  /** Alleen ElevenLabs; 0,7–1,2. Zie `ElevenLabsOptions.speed`. */
  readonly speed?: number;
}

/**
 * 24 kHz voor beide leveranciers.
 *
 * De keten zat op 16 kHz omdat Cartesia's WebSocket `sample_rate` negeerde. Dat is op
 * 26 augustus 2026 gemeten en klopt niet meer: verhouding 1,52 tussen 16 en 24 kHz over drie
 * runs per rate, waar genegeerd 1,00 zou geven. ElevenLabs honoreert het eveneens (1,47).
 *
 * Wat dat opent staat in risico 12: 24 kHz gaf reproduceerbaar ongeveer een derde minder
 * tikken. De reden om het níét te doen — zelf opschalen per chunk zet randeffecten neer op
 * precies de plekken die je onderzoekt — vervalt als je het rechtstreeks kunt vragen.
 *
 * Anam neemt 24 kHz aan, dus dit haalt tegelijk de resamplingstap uit de keten.
 */
export const TTS_SAMPLE_RATE = 24_000;

function ontbreekt(namen: string[], keuze: TtsKeuze): never {
  throw new Error(
    `mediaketen onvolledig voor TTS '${keuze}': ${namen.join(', ')}. ` +
      'Zet de ontbrekende variabelen, of kies een andere leverancier via ' +
      'provider_config.tts of TTS_PROVIDER (cartesia | elevenlabs | fake).',
  );
}

/**
 * Welke leverancier draait er?
 *
 * Volgorde: `TTS_PROVIDER` uit de omgeving wint, daarna wat het kantoor heeft ingesteld,
 * daarna ElevenLabs. De env-override staat bovenaan omdat hij bedoeld is om zonder commit een
 * proef te draaien — precies wat er nodig was om deze wissel te kunnen onderbouwen.
 */
export function ttsKeuzeVan(env: Partial<AgentEnv>, uitOrganisatie?: string | null): TtsKeuze {
  const kandidaat = env.TTS_PROVIDER ?? uitOrganisatie ?? 'elevenlabs';
  if (kandidaat === 'cartesia' || kandidaat === 'elevenlabs' || kandidaat === 'fake') {
    return kandidaat;
  }
  /*
   * Geen stille terugval.
   *
   * Een onbekende waarde in `provider_config.tts` betekent dat iemand iets heeft ingesteld
   * wat wij niet kennen. Daar stilzwijgend ElevenLabs van maken zou betekenen dat het kantoor
   * denkt iets te hebben gekozen terwijl er iets anders draait — en dat is precies de klasse
   * fout die deze fabriek moest wegnemen.
   */
  throw new Error(`onbekende TTS-leverancier '${kandidaat}'. Geldig: cartesia, elevenlabs, fake.`);
}

/**
 * De configuratie voor één leverancier uit de omgeving.
 *
 * `stemUitOrganisatie` is `provider_config.ttsVoiceId`: het kantoor mag een eigen stem kiezen
 * zonder dat de worker herstart. Staat hij leeg, dan valt hij terug op de env-stem.
 */
export function ttsConfigFrom(
  env: Partial<AgentEnv>,
  keuze: TtsKeuze,
  stemUitOrganisatie?: string | null,
): TtsConfig {
  const stem = stemUitOrganisatie?.trim() || undefined;

  if (keuze === 'fake') {
    return { keuze, apiKey: '', voiceId: stem ?? 'fake', sampleRate: TTS_SAMPLE_RATE };
  }

  if (keuze === 'cartesia') {
    const mist: string[] = [];
    if (!env.CARTESIA_API_KEY) mist.push('CARTESIA_API_KEY');
    if (!stem && !env.CARTESIA_VOICE_ID) mist.push('CARTESIA_VOICE_ID');
    if (mist.length > 0) ontbreekt(mist, keuze);
    return {
      keuze,
      apiKey: env.CARTESIA_API_KEY!,
      voiceId: stem ?? env.CARTESIA_VOICE_ID!,
      ...(env.CARTESIA_MODEL ? { model: env.CARTESIA_MODEL } : {}),
      sampleRate: TTS_SAMPLE_RATE,
    };
  }

  const mist: string[] = [];
  if (!env.ELEVENLABS_API_KEY) mist.push('ELEVENLABS_API_KEY');
  if (!stem && !env.ELEVENLABS_VOICE_ID) mist.push('ELEVENLABS_VOICE_ID');
  if (mist.length > 0) ontbreekt(mist, keuze);
  return {
    keuze,
    apiKey: env.ELEVENLABS_API_KEY!,
    voiceId: stem ?? env.ELEVENLABS_VOICE_ID!,
    ...(env.ELEVENLABS_MODEL ? { model: env.ELEVENLABS_MODEL } : {}),
    sampleRate: TTS_SAMPLE_RATE,
    ...(env.ELEVENLABS_SPEED !== undefined ? { speed: env.ELEVENLABS_SPEED } : {}),
  };
}

/**
 * De leverancier zelf.
 *
 * `trimLeadingSilence` staat voor beide op dezelfde schakelaar, zodat `TTS_TRIM_LEADING=0`
 * blijft doen wat het deed: het snijden uitzetten om het verschil te hóren in plaats van te
 * meten.
 */
export function maakTtsProvider(config: TtsConfig): TextToSpeechProvider {
  const trimLeadingSilence = process.env['TTS_TRIM_LEADING'] !== '0';

  if (config.keuze === 'fake') return new FakeTtsProvider();

  if (config.keuze === 'cartesia') {
    return new CartesiaTtsProvider({
      apiKey: config.apiKey,
      sampleRate: config.sampleRate,
      trimLeadingSilence,
      ...(config.model ? { model: config.model } : {}),
    });
  }

  return new ElevenLabsTtsProvider({
    apiKey: config.apiKey,
    sampleRate: config.sampleRate,
    trimLeadingSilence,
    ...(config.model ? { model: config.model } : {}),
    ...(config.speed !== undefined ? { speed: config.speed } : {}),
  });
}
