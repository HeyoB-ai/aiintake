/**
 * Maakt (of vindt) de intake-persona bij Anam.
 *
 * ## Waarom dit moet bestaan
 *
 * Een stock-persona lenen werkt niet. Die draagt een eigen gezicht, een eigen stem, een
 * eigen taal én een eigen LLM, en dat laatste is het probleem: hun engine begroet de
 * cliënt uit zichzelf. Gemeten op een demo-persona: op 1276 ms kwam "¡Hola! Bienvenido"
 * binnen als `role: "persona"`, terwijl wij nog niets hadden gestuurd.
 *
 * Even belangrijk: een `avatarId` in de `personaConfig` meesturen doet níéts. Wij stuurden
 * personaId van Anika mét avatarId van Mia, kregen HTTP 200, en zagen Anika. De persona
 * is de enige knop die telt.
 *
 * Dit script zet daarom een eigen persona neer met `llmId: CUSTOMER_CLIENT_V1` — in hun
 * `GET /v1/llms` heet die "Disable LLM", `llmFormat: "none"`. Dat is de stand waarin hun
 * engine zwijgt en onze audio via `createAgentAudioInputStream` doorkomt. Beide kanten
 * gemeten met `pnpm --filter @intake/agent diag:stilte`: piek-RMS 0 uit zichzelf, 0,197
 * na onze eigen toon.
 *
 * Idempotent: bestaat er al een persona met deze naam, dan wordt die gerapporteerd en
 * niets gewijzigd.
 *
 * Draaien met: pnpm --filter @intake/agent anam:persona
 */

export {}; // top-level await vraagt een module; dit script importeert verder niets.

const API = 'https://api.anam.ai/v1';
const NAAM = 'Legal Intake NL';
const GEEN_LLM = 'CUSTOMER_CLIENT_V1';

const apiKey = process.env['ANAM_API_KEY'];
if (!apiKey) throw new Error('ANAM_API_KEY ontbreekt in .env');

const HEADERS = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

interface Persona {
  readonly id: string;
  readonly name: string;
  readonly llmId?: string;
  readonly languageCode?: string;
  readonly skipGreeting?: boolean;
  readonly avatar?: { displayName?: string };
}

async function json<T>(pad: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${pad}`, { headers: HEADERS, ...init });
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${pad} → HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const bestaand = (await json<{ data: Persona[] }>('/personas')).data.find((p) => p.name === NAAM);

if (bestaand) {
  console.log(`\n  Persona bestaat al: ${bestaand.id}\n`);
  const vol = await json<Persona>(`/personas/${bestaand.id}`);
  console.log(`  naam     ${vol.name}`);
  console.log(`  gezicht  ${vol.avatar?.displayName ?? '?'}`);
  console.log(
    `  llmId    ${vol.llmId} ${vol.llmId === GEEN_LLM ? '(stil — goed)' : '(PRAAT ZELF MEE)'}`,
  );
  console.log(`  taal     ${vol.languageCode}\n`);
  console.log(`  ANAM_PERSONA_ID=${bestaand.id}\n`);
  process.exit(vol.llmId === GEEN_LLM ? 0 : 1);
}

// Een gezicht en een stem kiezen. De stem is een verplicht veld dat bij passthrough niet
// gebruikt wordt; het gezicht is wél wat de cliënt ziet.
const avatarId =
  process.env['ANAM_AVATAR_ID'] ?? (await json<{ data: { id: string }[] }>('/avatars')).data[0]?.id;
const voiceId = (await json<{ data: { id: string }[] }>('/voices')).data[0]?.id;
if (!avatarId || !voiceId) throw new Error('geen avatar of stem beschikbaar op dit account');

const nieuw = await json<Persona>('/personas', {
  method: 'POST',
  body: JSON.stringify({
    name: NAAM,
    description: 'Nederlandse arbeidsrecht-intake. Wij leveren de audio; hun LLM en TTS staan uit.',
    avatarId,
    voiceId,
    llmId: GEEN_LLM,
    languageCode: 'nl',
    // Geen begroeting en geen systeemprompt: er is geen brein om ze aan te geven, en een
    // lege prompt is duidelijker dan een prompt die toevallig nooit gelezen wordt.
    skipGreeting: true,
    systemPrompt: '',
  }),
});

const vol = await json<Persona>(`/personas/${nieuw.id}`);
console.log(`\n  Persona aangemaakt: ${vol.id}`);
console.log(`  gezicht  ${vol.avatar?.displayName ?? '?'}`);
console.log(`  llmId    ${vol.llmId}`);
console.log(`  taal     ${vol.languageCode}\n`);

if (vol.llmId !== GEEN_LLM) {
  // Hun API accepteert velden die hij vervolgens negeert — `enableAudioPassthrough: true`
  // komt bijvoorbeeld altijd als `false` terug. Een 201 is hier dus geen bewijs.
  console.error(`  Maar llmId staat op ${vol.llmId}, niet op ${GEEN_LLM}. Niet bruikbaar.\n`);
  process.exit(1);
}

console.log(`  Zet in .env:\n\n  ANAM_PERSONA_ID=${vol.id}\n`);
