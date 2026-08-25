import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { context } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

/**
 * Een etalage voor de componenten, in één commando.
 *
 * ## Waarom dit geen route in apps/web is
 *
 * Een pagina die in de echte applicatie zit, is op een dag bereikbaar voor een cliënt. Deze
 * pagina toont vaste voorbeelddata, waaronder een urgentiesignaal — en dat is precies wat
 * een cliënt nooit te zien mag krijgen. Buiten de applicatie houden is dus geen netheid
 * maar dezelfde regel als waarom `DossierSidebar` geen `hideUrgency`-vlag heeft.
 *
 * ## Waarom geen tweede Vite-project
 *
 * Deze monorepo bouwt al met esbuild in de diagnoseharnassen. Nog een bundler erbij zou
 * betekenen dat een component in de etalage anders kan bouwen dan in productie, en dan
 * beoordeel je iets anders dan wat je verscheept. Tailwind draait via dezelfde
 * `@tailwindcss/postcss` als apps/web.
 *
 * Draaien met: pnpm preview
 */

const HIER = dirname(fileURLToPath(import.meta.url));
const POORT = Number(process.env['PREVIEW_PORT'] ?? 5180);

const HTML = `<!doctype html>
<html lang="nl" data-theme="modern-light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>UI-etalage — Legal Intake</title>
    <link rel="stylesheet" href="/preview.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/preview.js"></script>
  </body>
</html>`;

/*
 * esbuild in watch-modus.
 *
 * Een `context` in plaats van een losse `build`: dan wordt er bij elke wijziging opnieuw
 * gebundeld en is verversen genoeg. Zonder dat moet je de server herstarten voor elke
 * kleurwijziging, en dan kijk je vanzelf naar een oude versie zonder het te weten.
 */
const bundel = await context({
  entryPoints: [join(HIER, 'preview.tsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  write: false,
  logLevel: 'silent',
  // De componenten importeren uit @intake/domain; die resolvet esbuild via de werkruimte.
  absWorkingDir: join(HIER, '..'),
});
await bundel.watch();

async function js(): Promise<string> {
  const r = await bundel.rebuild();
  const fout = r.errors[0];
  if (fout) throw new Error(`${fout.text} (${fout.location?.file}:${fout.location?.line})`);
  return r.outputFiles?.[0]?.text ?? '';
}

async function css(): Promise<string> {
  const pad = join(HIER, 'preview.css');
  const bron = await readFile(pad, 'utf8');
  const r = await postcss([tailwind()]).process(bron, { from: pad });
  return r.css;
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const stuur = (type: string, inhoud: string): void => {
    res
      .writeHead(200, {
        'Content-Type': type,
        // Niet cachen: je kijkt naar deze pagina juist omdat hij verandert.
        'Cache-Control': 'no-store',
      })
      .end(inhoud);
  };

  const bezorg = async (): Promise<void> => {
    try {
      if (url === '/preview.js') return stuur('text/javascript; charset=utf-8', await js());
      if (url === '/preview.css') return stuur('text/css; charset=utf-8', await css());
      stuur('text/html; charset=utf-8', HTML);
    } catch (error) {
      // De fout in de pagina zetten en niet alleen in de terminal: wie hiernaar kijkt,
      // kijkt naar het scherm.
      const tekst = String(error).replace(/^Error: /, '');
      console.error(`  bouwfout: ${tekst}`);
      res
        .writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(`<pre style="padding:2rem;font:14px monospace;color:#b91c1c">${tekst}</pre>`);
    }
  };
  void bezorg();
});

server.listen(POORT, () => {
  console.log(`\n  UI-etalage:  http://localhost:${POORT}\n`);
  console.log('  Componenten uit packages/ui, gevoed uit fixtures.ts.');
  console.log('  Wijzig een component en ververs de pagina — esbuild bouwt mee.');
  console.log('  Stop met ctrl-c.\n');
});

const stop = (): void => {
  void bundel.dispose().then(() => {
    server.close();
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
