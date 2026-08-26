import { describe, expect, it } from 'vitest';
import { conversationPrompt, type ConversationVars } from './conversation';

/**
 * De opening, en dan vooral: spreekt ze de cliënt aan?
 *
 * De naam staat sinds 26 augustus op de intake, ingevuld op het toestemmingsscherm. De
 * worker haalde hem nooit op en de prompt kende het veld niet, dus begon elk gesprek met
 * "Goedemiddag. Ik ben de AI-intake-assistent van…" tegen iemand die net zijn naam had
 * ingetypt.
 */

const BASIS: ConversationVars = {
  organisationName: 'Kantoor De Vries',
  practiceAreaLabel: 'arbeidsrecht',
  candidates: [],
  knownFacts: [],
  maxSentences: 4,
  allowFiller: false,
  isOpening: true,
  isClosing: false,
  narrativePhase: true,
  greeting: 'Goedemiddag',
  clientName: null,
};

const openingNl = (v: Partial<ConversationVars>) =>
  conversationPrompt.render({ ...BASIS, ...v }, 'nl');

describe('opening met naam', () => {
  it('zet de naam achter de groet', () => {
    const tekst = openingNl({ clientName: 'Sanne de Vries' });
    expect(tekst).toContain('Goedemiddag, Sanne de Vries.');
  });

  it('instrueert de naam letterlijk over te nemen', () => {
    const tekst = openingNl({ clientName: 'Sanne de Vries' });
    // Geen verzonnen aanhef: "meneer"/"mevrouw" raden we niet, want we weten het niet.
    expect(tekst).toContain('niet inkorten');
    expect(tekst).toMatch(/geen aanhef/i);
  });

  it('verzint geen naam als hij ontbreekt', () => {
    const tekst = openingNl({ clientName: null });
    expect(tekst).toContain('Goedemiddag. ');
    expect(tekst).toContain('De naam van de cliënt is niet bekend');
  });

  it('laat de groet weg midden in de nacht, ook mét naam', () => {
    // groet is null tussen middernacht en zes uur; dan is er niets om de naam achter te
    // plakken en begint de assistent gewoon met wie ze is.
    const tekst = openingNl({ greeting: null, clientName: 'Sanne de Vries' });
    expect(tekst).toContain('Ik ben de AI-intake-assistent van Kantoor De Vries.');
    expect(tekst).not.toContain('Goedemiddag');
  });

  it('noemt de naam niet in een gewone beurt', () => {
    // Alleen de opening spreekt aan. Elke beurt met een naam ervoor klinkt als een
    // callcenter dat zijn script afwerkt.
    const tekst = openingNl({ isOpening: false, clientName: 'Sanne de Vries' });
    expect(tekst).not.toContain('Sanne de Vries');
  });
});
