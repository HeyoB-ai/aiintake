-- ElevenLabs wordt de standaard-TTS.
--
-- ## Waarom
--
-- Gemeten met `pnpm diag:tts-vergelijk` op 26 augustus 2026, negen metingen per leverancier
-- op de openingszin:
--
--                                      Cartesia  ElevenLabs
--   "Goedenavond" volledig weg            7/9       0/9
--   "geen advocaat" weg of verminkt       1/9       0/9
--   herhaalde reeks van 3+ woorden        2/9       0/9
--
-- De tweede regel gaf de doorslag. Cartesia leverde "ik ben advocaat en ben aangesteld om
-- de gegevens van uw zaak vast te leggen" -- het woord "geen" weg. De disclaimer zegt dan
-- het tegenovergestelde van wat er staat, in een gesprek waarin de client precies voor die
-- zin heeft getekend. Eerste audio scheelt 8 ms, dus daar zit de afweging niet.
--
-- ## Waarom dit een migratie nodig heeft en niet alleen een default
--
-- `ProviderConfigSchema.tts` heeft een zod-default, maar bestaande rijen dragen 'cartesia'
-- expliciet -- de seed zette hem zo. Een default aanpassen raakt die rijen niet. Zonder deze
-- migratie zou de code op ElevenLabs staan en de database op Cartesia, en dan draait er iets
-- anders dan er in de repo staat. Dat is precies de vorm die we net hebben opgeruimd.
--
-- ## Waarom ttsVoiceId meegaat
--
-- Een stem-id hoort bij een leverancier. Een Cartesia-UUID naar ElevenLabs sturen levert een
-- fout op bij de eerste zin van het eerste gesprek -- niet stil, maar wel te laat. Wie de
-- leverancier wisselt zonder de stem los te laten, wisselt niet.
--
-- Op null zetten laat de worker terugvallen op ELEVENLABS_VOICE_ID uit de omgeving. Het
-- kantoor kan daarna een eigen ElevenLabs-stem kiezen.
--
-- ## Wat dit niet doet
--
-- Cartesia blijft een geldige waarde en blijft werkend. Wie de vergelijking wil herhalen zet
-- `provider_config.tts` terug op 'cartesia' met de bijbehorende stem, of gebruikt
-- `TTS_PROVIDER` in de omgeving voor een losse proef.

update public.organizations
set provider_config = jsonb_set(
      jsonb_set(provider_config, '{tts}', '"elevenlabs"'::jsonb, true),
      '{ttsVoiceId}', 'null'::jsonb, true
    )
where coalesce(provider_config->>'tts', 'cartesia') = 'cartesia';
