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

/*
 * Hier stond `describe('opening met naam')`, met vier tests op de instructie: dat de naam
 * achter de groet komt, dat het model hem letterlijk moet overnemen, dat het er geen mag
 * verzinnen, en dat de groet 's nachts wegblijft.
 *
 * Die vier gingen over een sjabloon dat het model moest volgen. De opening is sinds
 * 27 augustus 2026 een vaste zin die helemaal niet meer langs een model gaat, en dat sjabloon
 * is uit deze prompt verdwenen — een instructie die niemand leest, is de vorm waarin een
 * afspraak stilletjes verandert.
 *
 * De vier garanties zijn niet vervallen maar verplaatst, naar waar ze nu te meten zijn in
 * plaats van te hopen: `packages/domain/src/opening.test.ts`, onder "de invulplekken".
 */

describe('hervatting', () => {
  const hervat = (v: Partial<ConversationVars>) =>
    conversationPrompt.render({ ...BASIS, ...v, isOpening: false, isResuming: true }, 'nl');

  it('verbiedt verwijzen naar wat er eerder is verteld', () => {
    const tekst = hervat({ clientName: 'Sanne de Vries' });
    expect(tekst).toContain('Niet samenvatten wat er eerder is verteld');
    // Dit is de reden, en die hoort in de prompt te staan zodat hij niet wegbezuinigd wordt.
    expect(tekst).toContain('nog niet vast in het dossier');
  });

  it('verbiedt de opening opnieuw voor te lezen', () => {
    const tekst = hervat({ clientName: 'Sanne de Vries' });
    expect(tekst).toContain('Niet opnieuw vertellen wie je bent');
  });

  it('bouwt niet óók de volledige opening', () => {
    const tekst = hervat({ clientName: 'Sanne de Vries' });
    expect(tekst).not.toContain('Dit is de opening');
  });
});
