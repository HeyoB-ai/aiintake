#!/usr/bin/env node
/**
 * Staat er een bestand met echte gegevens in de repo, of op het punt erin te komen?
 *
 * ## Waarom dit bestaat
 *
 * Twee keer misgegaan, en allebei op dezelfde manier. Er lag een `.env111.txt` met live
 * sleutels in de hoofdmap, gedekt door geen enkel ignore-patroon — hij ontsnapte alleen
 * doordat niemand hem toevallig had toegevoegd. En een `number,name,bedrijfsnaam.csv` met een
 * naam en een telefoonnummer werd door `git add -A` in een commit getrokken; die is er
 * uitgehaald voordat er iets gepusht was, maar dat was toeval en geen bewaker.
 *
 * De hoofdmap is de plek waar dat gebeurt. Daar zet je iets even neer — een export, een
 * lijstje uit een klantsysteem — en `add -A` pakt alles mee.
 *
 * ## Twee controles, en maar één ervan blokkeert
 *
 * **Getrackt** is een fout: dan staat het bestand in de geschiedenis en is het na een push
 * niet meer weg te krijgen zonder die te herschrijven. Dat blokkeert.
 *
 * **Ongetrackt** is een waarschuwing. Zo'n bestand kan niet gepusht worden — maar hij ligt er
 * wel, en de volgende `git add -A` pakt hem. De melding is er om dat te zien vóórdat het zover
 * is, niet erna. Blokkeren zou verkeerd zijn: er is niets mis met een export op je eigen
 * machine, en een gate die tegenhoudt wat niet fout is, wordt uitgezet.
 *
 * Draaien met: node scripts/check-losse-gegevens.mjs
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

/**
 * Extensies waarin gegevens plegen te belanden, in de hoofdmap.
 *
 * Alleen de hoofdmap: een `.txt` met testdata in `packages/` hoort gewoon getrackt te worden,
 * en die weigeren zou van deze controle iets maken dat mensen omzeilen.
 */
const RISICO_EXTENSIES = ['csv', 'tsv', 'txt', 'xls', 'xlsx', 'vcf'];

/**
 * `.env` in alle vormen, overal — behalve de sjablonen.
 *
 * `.env111.txt` paste in geen enkel patroon dat er stond. Deze regel is daarom breed: alles wat
 * met `.env` begint telt, ongeacht wat erachter staat.
 */
const ENV_PATROON = /(^|\/)\.env/;
const SJABLOON = /(^|\/)\.env\.example$/;

const rootPatroon = new RegExp(`^[^/]+\\.(${RISICO_EXTENSIES.join('|')})$`, 'i');

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function isRisico(pad) {
  if (SJABLOON.test(pad)) return false;
  if (ENV_PATROON.test(pad)) return true;
  return rootPatroon.test(pad);
}

const getrackt = git('ls-files')
  .split('\n')
  .map((r) => r.trim())
  .filter(Boolean)
  .filter(isRisico);

/*
 * De schijfscan gaat NIET via git.
 *
 * `git ls-files --others` zonder `--exclude-standard` loopt door node_modules en .turbo heen:
 * 283.000 paden, en `execFileSync` knalt op ENOBUFS. Mét `--exclude-standard` verbergt hij
 * precies de bestanden die we net in .gitignore hebben gezet — en dan zwijgt deze controle
 * zodra hij één keer heeft geholpen.
 *
 * De hoofdmap zelf uitlezen is allebei niet: het is één readdir, en genegeerd of niet doet er
 * voor het zien niet toe. Of ze meegaan met een push, vraagt `git check-ignore` daarna.
 */
const inRoot = readdirSync('.', { withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => d.name)
  .filter(isRisico)
  .sort();

/** Welke daarvan door .gitignore worden gedekt. Geen match is geen fout, dus exit 1 negeren. */
function genegeerdeBestanden(paden) {
  if (paden.length === 0) return new Set();
  try {
    return new Set(
      execFileSync('git', ['check-ignore', '--', ...paden], { encoding: 'utf8' })
        .split('\n')
        .map((r) => r.trim())
        .filter(Boolean),
    );
  } catch {
    // Exit 1 betekent "geen enkele is genegeerd" en is hier een geldig antwoord.
    return new Set();
  }
}

const genegeerd = genegeerdeBestanden(inRoot);
/*
 * Getrackte bestanden vallen buiten de schijfmeldingen.
 *
 * Anders staat één bestand onder twee koppen die elkaar tegenspreken: "gaat mee met de push"
 * én "wordt niet gepusht". Wat getrackt is, is al de zwaarste melding; die hieronder gaan over
 * wat er nog kán gebeuren.
 */
const isGetrackt = new Set(getrackt);
const ongetrackt = inRoot.filter((pad) => !genegeerd.has(pad) && !isGetrackt.has(pad));
const genegeerdRisico = inRoot.filter((pad) => genegeerd.has(pad) && !isGetrackt.has(pad));

process.stdout.write('\n  Losse gegevensbestanden: staat er iets in de repo dat er niet hoort?\n\n');

let ok = true;

if (getrackt.length > 0) {
  ok = false;
  process.stdout.write('    FAIL deze bestanden zijn GETRACKT en gaan mee met de push:\n');
  for (const pad of getrackt) process.stdout.write(`           ${pad}\n`);
  process.stdout.write(
    '\n         Na een push staan ze in de geschiedenis en zijn ze daar niet meer uit te\n' +
      '         halen zonder die te herschrijven. Haal ze eruit met:\n\n' +
      `           git rm --cached "${getrackt[0]}"\n\n` +
      '         en zet ze in .gitignore. Bevatten ze persoonsgegevens en is er al gepusht,\n' +
      '         dan is dat een datalek en geen opruimklus.\n\n',
  );
}

if (ongetrackt.length > 0) {
  process.stdout.write('    let op: deze liggen los in de werkmap (niet getrackt):\n');
  for (const pad of ongetrackt) process.stdout.write(`           ${pad}\n`);
  process.stdout.write(
    '\n         Ze worden niet gepusht. Maar de volgende `git add -A` pakt ze wel, en dat is\n' +
      '         precies hoe het twee keer bijna misging. Zet ze in .gitignore of verplaats ze\n' +
      '         naar buiten de repo.\n\n',
  );
}

if (genegeerdRisico.length > 0) {
  /*
   * Geen fout en geen waarschuwing: deze zijn afgedekt. Wel noemen, want ze bestáán nog. Een
   * bestand met echte gegevens dat je bent vergeten, is iets anders dan een bestand dat er
   * niet is — en een controle die zwijgt zodra .gitignore klopt, laat je vergeten wat er ligt.
   */
  process.stdout.write('    genegeerd (gaan niet mee met een push), maar ze liggen er nog:\n');
  for (const pad of genegeerdRisico) process.stdout.write(`           ${pad}\n`);
  process.stdout.write('\n');
}

if (ok && ongetrackt.length === 0 && genegeerdRisico.length === 0) {
  process.stdout.write('    ok   niets losliggends in de hoofdmap, niets getrackt.\n\n');
} else if (ok) {
  process.stdout.write('  Niets getrackt; de push gaat door.\n\n');
}

process.exit(ok ? 0 : 1);
