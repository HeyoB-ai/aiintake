/**
 * Architectuurgrenzen — §3 van de buildspec.
 *
 * De belangrijkste regel van dit bestand: `packages/intake-engine` mag alleen
 * `packages/domain` en `packages/prompts` importeren. Breekt die regel, dan is de
 * architectuur gebroken en werkt de intake-intelligentie niet langer identiek in
 * videomodus en chat-fallback.
 *
 * Deze config draait in CI (`pnpm boundaries`) en faalt de build bij overtreding.
 */

/**
 * SDK's die nooit in vendor-onafhankelijke packages mogen voorkomen.
 *
 * `(^|node_modules/)` en niet alleen `^`: dependency-cruiser rapporteert een
 * geïnstalleerd pakket als `node_modules/<naam>/...` en een niet-installeerbaar pakket
 * als de kale naam. Met alleen `^` vangt de regel het tweede geval wel en het eerste
 * niet — en juist het eerste is het geval dat ontstaat als iemand de SDK netjes aan
 * package.json toevoegt.
 *
 * In een pnpm-workspace is `no-unresolvable` de facto de eerste vangst, omdat een
 * niet-gedeclareerd pakket daar sowieso niet resolvet. Deze regel is de tweede laag,
 * voor wanneer de dependency wél wordt toegevoegd.
 */
const VENDOR_SDKS = [
  '(^|node_modules/)@anthropic-ai/',
  '(^|node_modules/)openai$',
  '(^|node_modules/)@deepgram/',
  '(^|node_modules/)@cartesia/',
  '(^|node_modules/)elevenlabs$',
  '(^|node_modules/)@elevenlabs/',
  '(^|node_modules/)livekit-client',
  '(^|node_modules/)@livekit/',
  '(^|node_modules/)livekit-server-sdk',
  '(^|node_modules/)@supabase/',
  '(^|node_modules/)@mediapipe/',
  '(^|node_modules/)@bey/',
  '(^|node_modules/)@anam-ai/',
].join('|');

/**
 * Een workspace-import komt in twee gedaanten voorbij, en een regel die er maar één
 * van dekt, slaagt vacuüm:
 *
 *   1. staat het pakket in package.json, dan resolvet pnpm het via de symlink en
 *      rapporteert dependency-cruiser het echte pad (`packages/db-core/src/index.ts`);
 *   2. staat het er niet in, dan is er geen symlink, blijft het onopgelost en
 *      rapporteert hij alleen de modulenaam (`@intake/db-core`).
 *
 * De helper hieronder bouwt een patroon dat beide vormen vangt. De `no-unresolvable`
 * regel verderop vangt geval 2 bovendien projectbreed af.
 */
function outsideWorkspace(...allowed) {
  const dirs = allowed.join('|');
  const names = allowed.join('|');
  return `^(packages/(?!(${dirs})/)|@intake/(?!(${names})$))`;
}

module.exports = {
  forbidden: [
    {
      name: 'engine-only-domain-and-prompts',
      severity: 'error',
      comment:
        'packages/intake-engine mag uitsluitend packages/domain en packages/prompts importeren. ' +
        'Geen providers, geen db, geen ui, geen apps.',
      from: { path: '^packages/intake-engine/' },
      to: {
        path: outsideWorkspace('intake-engine', 'domain', 'prompts'),
      },
    },
    {
      name: 'no-unresolvable',
      severity: 'error',
      comment:
        'Een import die niet te resolven is, is meestal een package dat wel wordt ' +
        'geïmporteerd maar niet in package.json staat. Zonder deze regel glippen ' +
        'boundary-overtredingen erdoorheen, want een onopgelost pad matcht geen padregel.',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'engine-no-vendor-sdk',
      severity: 'error',
      comment:
        'De intake-intelligentie is vendor-onafhankelijk (§2.2). Geen avatar-, STT-, TTS- of LLM-SDK.',
      from: { path: '^packages/intake-engine/' },
      to: { dependencyTypes: ['npm'], path: VENDOR_SDKS },
    },
    {
      name: 'engine-no-io',
      severity: 'error',
      comment:
        'De engine doet geen I/O: input = toestand, output = beslissing. Geen node builtins, ' +
        'zodat hij unit-getest kan worden zonder één netwerkcall.',
      from: { path: '^packages/intake-engine/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['core'] },
    },
    {
      name: 'domain-is-a-leaf',
      severity: 'error',
      comment: 'packages/domain is de onderste laag en importeert geen andere workspace-package.',
      from: { path: '^packages/domain/' },
      to: { path: outsideWorkspace('domain') },
    },
    {
      name: 'prompts-only-domain',
      severity: 'error',
      comment: 'packages/prompts mag alleen packages/domain importeren.',
      from: { path: '^packages/prompts/' },
      to: { path: outsideWorkspace('prompts', 'domain') },
    },
    {
      name: 'providers-never-import-engine',
      severity: 'error',
      comment:
        'Providers zijn vervangbare randlaag. Zij kennen de engine niet; de engine kent hen niet.',
      from: { path: '^packages/providers/' },
      to: { path: '^(packages/intake-engine/|@intake/engine$)' },
    },
    {
      name: 'agent-never-imports-full-db',
      severity: 'error',
      comment:
        'apps/agent hangt aan @intake/db-core, niet aan @intake/db. Dat laatste pakket ' +
        'exporteert de RLS-omzeilende client, de envlezer met het ondertekeningsgeheim en ' +
        'het minten van tokens. Een langlevend, van buiten bereikbaar proces hoort daar ' +
        'fysiek niet bij te kunnen.',
      from: { path: '^apps/agent/' },
      to: { path: '^(packages/db/|@intake/db$)' },
    },
    {
      name: 'visual-provider-stays-in-the-browser',
      severity: 'error',
      comment:
        '§2.6: geen videoframes verlaten het apparaat. De visual provider mag geen netwerk- of ' +
        'db-laag aanraken; er gaan alleen booleans over de datachannel.',
      from: { path: '^packages/providers/visual/' },
      to: { path: '^packages/(db|providers/(llm|stt|tts|avatar))/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Cyclische afhankelijkheden maken de laagindeling betekenisloos.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$',
          '(^|/)tsconfig\\.json$',
          '(^|/)(babel|webpack|next|postcss|tailwind|vitest)\\.config\\.(js|cjs|mjs|ts)$',
          // Varianten als vitest.integration.config.ts en vitest.bakeoff.config.ts:
          // entrypoints voor de testrunner, niet iets wat geïmporteerd wordt.
          // Als losse regel geschreven omdat een geneste quantifier in het patroon
          // hierboven door de ReDoS-controle van dependency-cruiser wordt geweigerd.
          '(^|/)vitest\\.[\\w-]+\\.config\\.ts$',
          // De bakeoff-meetpagina wordt door esbuild gebundeld en door de browser
          // geladen; niets in deze repo importeert hem.
          'apps/[^/]+/bakeoff/.*',
          // De praatpagina: een lokaal server-startpunt plus een HTML-pagina.
          // Niemand importeert die; hij wordt gedraaid.
          'apps/[^/]+/live/.*',
          // App Router-bestanden zijn per definitie losse entrypoints: Next.js roept
          // page/layout/route/middleware aan, niemand importeert ze.
          'apps/[^/]+/src/app/.*',
          'apps/[^/]+/src/middleware\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'not-to-dev-dep',
      severity: 'error',
      comment:
        'Productiecode mag geen devDependency importeren. Tests en configbestanden ' +
        'natuurlijk wel — die zijn zelf geen productiecode.',
      from: {
        path: '^(packages|apps)/',
        pathNot: [
          '\\.(test|spec)\\.tsx?$',
          '\\.integration\\.test\\.ts$',
          // vitest.config.ts, next.config.ts, en broertjes: buildgereedschap.
          '(^|/)[\\w.-]+\\.config\\.(ts|js|cjs|mjs)$',
          // Het meetharnas van de bakeoff draait alleen met pnpm test:bakeoff.
          'apps/[^/]+/bakeoff/.*',
          // De praatpagina: een lokaal server-startpunt plus een HTML-pagina.
          // Niemand importeert die; hij wordt gedraaid.
          'apps/[^/]+/live/.*',
        ],
      },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    // `doNotFollow` en niet `exclude` voor node_modules, en dat verschil is het hele punt.
    //
    // `doNotFollow` houdt het pakket in de graaf als bladknoop maar loopt er niet in door.
    // `exclude` gooit het eruit. Stond node_modules in `exclude`, dan verdween elke
    // geïnstalleerde npm-dependency uit de dependencylijst — en daarmee kon geen enkele
    // regel die op `dependencyTypes: ['npm']` staat ooit nog vuren.
    //
    // Dat was hier het geval, en het maakte twee regels stilzwijgend krachteloos:
    // `engine-no-vendor-sdk` en `not-to-dev-dep`. Beide leken te werken omdat een
    // *niet-gedeclareerd* pakket onopgelost blijft en dan alsnog door `no-unresolvable`
    // wordt gepakt. Maar juist het geval dat je wilt afvangen — iemand voegt de SDK netjes
    // aan package.json toe en importeert hem dan — was groen.
    doNotFollow: { path: 'node_modules' },
    // Verankerd op onze eigen mappen, en dat is niet cosmetisch.
    //
    // Hier stond het kale patroon `dist`. Dat matcht overal, dus ook de `dist/`-map van
    // elk npm-pakket — en zo verdween @livekit/agents (dist/index.cjs) uit de graaf,
    // terwijl zod (lib/index.mjs) er wel in stond. Een vendorregel die per pakket
    // afhangt van hoe de leverancier zijn buildmap noemt, is geen regel.
    //
    // next-env.d.ts verwijst naar interne Next-typedeclaraties die niet als module
    // resolven; het bestand wordt door Next gegenereerd en zegt niets over architectuur.
    exclude: {
      path: [
        '^(packages|apps)/[^/]+/dist/',
        '(^|/)\\.next/',
        '(^|/)\\.turbo/',
        '(^|/)next-env\\.d\\.ts$',
      ],
    },
    tsPreCompilationDeps: true,
    // Zie tsconfig.depcruise.json voor waarom dit niet de base-config is.
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.js', '.jsx', '.ts', '.tsx'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
