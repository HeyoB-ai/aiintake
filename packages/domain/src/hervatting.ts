import type { Language } from './enums';

/**
 * De tweede opening: iemand komt terug in een gesprek dat al liep.
 *
 * ## Waarom dit bestaat
 *
 * Sinds de worker het transcript uit `agent_context` laadt, is `turnCount` bij een tweede
 * verbinding niet meer nul. De volledige opening viel daardoor weg — en dat is op zichzelf
 * juist, want de AI-mededeling twee keer voorlezen is raar. Maar er kwam ook niets voor in
 * de plaats. Iemand die zijn verbinding kwijtraakt en terugkomt, vraagt zich af of het
 * systeem hem nog kent, en stilte is daar het slechtste antwoord op.
 *
 * ## Waarom de zin vastligt en niet wordt gegenereerd
 *
 * Dezelfde reden als bij de erkenning, en hier scherper. Het model krijgt de geschiedenis
 * mee als dialoog. Vraag je het om "kort te hervatten", dan is het één generatie ver van
 * "u vertelde dat u op staande voet bent ontslagen" — en dat is een bewering over wat er is
 * vastgelegd, terwijl er op dit moment nog helemaal niets in het dossier staat. De belofte
 * die dan wordt gedaan, kan het systeem niet waarmaken.
 *
 * Dus: één vaste zin, met de naam erin en verder niets. Geen samenvatting, geen verwijzing
 * naar wat er is gezegd, geen inschatting van hoe ver we zijn. De vraag die erop volgt komt
 * van de planner, zoals bij elke andere beurt.
 *
 * ## Wat er bewust níét in staat
 *
 * "Waar waren we gebleven?" — dat is een vraag, en de vraag is aan de planner. Twee vragen
 * in één beurt is precies wat de gespreksvorm verbiedt.
 *
 * "Fijn dat u er weer bent" — dat veronderstelt dat het wegvallen vrijwillig was. Iemand
 * met een haperende verbinding is niet weggeweest, die is eruit gegooid.
 */

export interface HervattingOpties {
  /** De groet die bij het tijdstip hoort, of `null` 's nachts. Zie groet.ts. */
  readonly greeting: string | null;
  /** De naam die de cliënt heeft ingevuld, of `null`. */
  readonly clientName: string | null;
}

export function hervattingsZin(o: HervattingOpties, language: Language = 'nl'): string {
  const aanspreken = o.clientName ? `${o.greeting ? `${o.greeting}, ` : ''}${o.clientName}.` : null;

  if (language === 'en') {
    return aanspreken
      ? `${aanspreken} We are picking up where we left off.`
      : 'We are picking up where we left off.';
  }

  /*
   * "We gaan verder waar we gebleven waren" en niet "waar we waren gebleven".
   *
   * De eerste zegt iets over het gesprek, de tweede klinkt als een vraag naar de inhoud.
   * Het verschil is klein en het is het hele punt van deze zin.
   */
  return aanspreken
    ? `${aanspreken} We gaan verder waar we gebleven waren.`
    : 'We gaan verder waar we gebleven waren.';
}

/** Alle varianten, zodat een test kan controleren wat er níét in staat. */
export const ALLE_HERVATTINGSZINNEN: readonly string[] = [
  hervattingsZin({ greeting: 'Goedemiddag', clientName: 'Sanne de Vries' }, 'nl'),
  hervattingsZin({ greeting: null, clientName: 'Sanne de Vries' }, 'nl'),
  hervattingsZin({ greeting: 'Goedemiddag', clientName: null }, 'nl'),
  hervattingsZin({ greeting: 'Good afternoon', clientName: 'Sanne de Vries' }, 'en'),
  hervattingsZin({ greeting: null, clientName: null }, 'en'),
];
