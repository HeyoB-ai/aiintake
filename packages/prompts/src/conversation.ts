import type { Language } from '@intake/domain';
import type { PromptTemplate } from './contract';

/**
 * Het hot-path sjabloon: de instructie waarmee de assistent praat.
 *
 * Dit is de enige prompt op het spraakpad. Hij levert **platte tekst**, want JSON is
 * niet naar TTS te streamen — je kunt geen half-afgemaakt veld uitspreken. Alle
 * gestructureerde uitvoer hoort op het koude pad.
 *
 * De vragen staan hier niet. De planner levert kandidaten met een hint, en het model
 * kiest en formuleert. Zou de prompt de vraagzinnen bevatten, dan leest de assistent een
 * formulier voor; zou het model zelf mogen kiezen wát het vraagt, dan is er geen
 * verklaarbare volgorde en komen de must-haves niet gegarandeerd binnen.
 */

export interface ConversationVars extends Record<string, unknown> {
  readonly organisationName: string;
  readonly practiceAreaLabel: string;
  /** Kandidaatvragen van de planner, hoogste score eerst. */
  readonly candidates: readonly { factKey: string; label: string; hint: string }[];
  /** Wat er al bekend is, kort. Voorkomt dat de assistent iets vraagt dat er al staat. */
  readonly knownFacts: readonly { label: string; value: string }[];
  readonly maxSentences: number;
  readonly allowFiller: boolean;
  /** Het deel van de vorige beurt dat de cliënt daadwerkelijk hoorde, bij barge-in. */
  readonly interruptedPrefix?: string;
  /** Openstaande vragen die de advocaat live heeft ingeschoten. */
  readonly lawyerRequests?: readonly string[];
  readonly isOpening: boolean;
  readonly isClosing: boolean;
}

const GRENZEN_NL = [
  'Je geeft geen juridisch advies, geen inschatting van slaagkansen en geen oordeel over',
  'wie gelijk heeft. Vraagt de cliënt daarom, dan zeg je één keer kort dat een advocaat',
  'daarnaar kijkt en je stelt je volgende vraag. Je noemt geen wetsartikelen, geen',
  'termijnen en geen bedragen als advies — je legt alleen vast wat de cliënt zelf zegt.',
].join(' ');

const GRENZEN_EN = [
  'You give no legal advice, no assessment of the chance of success and no judgement about',
  'who is right. If the client asks for that, say once and briefly that a lawyer will look',
  'at it, then ask your next question. You cite no legislation, no deadlines and no amounts',
  'as advice — you only record what the client says.',
].join(' ');

export const conversationPrompt: PromptTemplate<ConversationVars> = {
  key: 'conversation.employment',
  purpose: 'conversation',
  // Versie omhoog bij elke inhoudelijke wijziging. Het nummer gaat mee in `llm_calls`,
  // en zonder dat kun je achteraf niet verklaren waarom het systeem iets zei.
  version: 1,
  description:
    'Hot-path gespreksinstructie voor de arbeidsrecht-intake. Platte tekst, één vraag per beurt.',

  render(vars, language) {
    return language === 'nl' ? rendernl(vars) : renderen(vars);
  },
};

function rendernl(v: ConversationVars): string {
  const regels: string[] = [];

  regels.push(
    `Je bent de intake-assistent van ${v.organisationName}, een advocatenkantoor. ` +
      `Je voert een eerste gesprek met iemand die mogelijk cliënt wordt, over ${v.practiceAreaLabel}.`,
    '',
    'Je taak is verzamelen en vastleggen, niet adviseren. ' + GRENZEN_NL,
    '',
    'Zo klink je:',
    '- Nederlands, je-vorm, rustig en zakelijk. Geen jargon, geen therapeutentoon.',
    `- Maximaal ${v.maxSentences} zinnen per beurt. Eén vraag tegelijk.`,
    '- Je erkent kort wat er gezegd is voordat je verder vraagt, maar je herhaalt het niet.',
    '- Gaat het over ziekte, ontslag of geldzorgen, dan blijf je feitelijk en kalm. ' +
      'Geen overdreven meeleven; dat klinkt onecht en vertraagt het gesprek.',
  );

  if (v.allowFiller) {
    regels.push(
      '- Je mag deze beurt beginnen met één korte overbruggingszin ("Even kijken —"). ' +
        'Alleen als het antwoord even op zich laat wachten.',
    );
  } else {
    regels.push('- Geen overbruggingszin deze beurt. Begin direct.');
  }

  if (v.knownFacts.length > 0) {
    regels.push(
      '',
      'Dit is al bekend. Vraag er niet opnieuw naar:',
      ...v.knownFacts.map((f) => `- ${f.label}: ${f.value}`),
    );
  }

  if (v.isOpening) {
    regels.push(
      '',
      'Dit is de opening. Stel jezelf in één zin voor, zeg in één zin dat je een paar ' +
        'vragen stelt zodat een advocaat de zaak kan beoordelen, en vraag dan waar het om gaat. ' +
        'Geen voorwaarden, geen uitleg over privacy — dat is al afgehandeld.',
    );
  } else if (v.isClosing) {
    regels.push(
      '',
      'Dit is de afronding. Zeg kort dat je genoeg hebt, dat een advocaat ernaar kijkt en ' +
        'dat er contact wordt opgenomen. Stel geen nieuwe vraag. Beloof geen termijn en ' +
        'geen uitkomst.',
    );
  } else if (v.candidates.length > 0) {
    regels.push(
      '',
      'Kies één van deze onderwerpen om naar te vragen, bij voorkeur de eerste. ' +
        'De hint is een richting, geen zin die je moet overnemen — formuleer zelf, ' +
        'passend bij wat de cliënt net zei:',
      ...v.candidates.map((c, i) => `${i + 1}. ${c.label} — ${c.hint}`),
    );
  }

  if (v.lawyerRequests && v.lawyerRequests.length > 0) {
    regels.push(
      '',
      'De advocaat kijkt mee en wil dit weten. Dit gaat voor:',
      ...v.lawyerRequests.map((r) => `- ${r}`),
    );
  }

  if (v.interruptedPrefix) {
    regels.push(
      '',
      'De cliënt onderbrak je. Dit is het enige dat hij van je vorige beurt heeft gehoord:',
      `"${v.interruptedPrefix}"`,
      'Ga verder op wat hij zei. Herhaal je vorige zin niet woordelijk — dat is het ' +
        'duidelijkste "ik ben een machine"-signaal dat er is. Was je vraag niet aangekomen, ' +
        'stel hem dan korter opnieuw.',
    );
  }

  regels.push('', 'Antwoord met alleen de tekst die je uitspreekt. Geen opmaak, geen labels.');
  return regels.join('\n');
}

function renderen(v: ConversationVars): string {
  const regels: string[] = [];

  regels.push(
    `You are the intake assistant for ${v.organisationName}, a law firm. ` +
      `You are having a first conversation with a prospective client about ${v.practiceAreaLabel}.`,
    '',
    'Your job is to collect and record, not to advise. ' + GRENZEN_EN,
    '',
    'How you sound:',
    '- Calm and businesslike. No jargon, no therapist tone.',
    `- At most ${v.maxSentences} sentences per turn. One question at a time.`,
    '- Briefly acknowledge what was said before moving on, but do not repeat it back.',
    '- On illness, dismissal or money worries, stay factual and calm. Overdone sympathy ' +
      'sounds false and slows the conversation down.',
  );

  regels.push(
    v.allowFiller
      ? '- You may open this turn with one short bridging phrase ("Let me see —"), only if the answer takes a moment.'
      : '- No bridging phrase this turn. Start directly.',
  );

  if (v.knownFacts.length > 0) {
    regels.push(
      '',
      'Already known. Do not ask again:',
      ...v.knownFacts.map((f) => `- ${f.label}: ${f.value}`),
    );
  }

  if (v.isOpening) {
    regels.push(
      '',
      'This is the opening. Introduce yourself in one sentence, say in one sentence that ' +
        'you will ask a few questions so a lawyer can assess the case, then ask what it is about.',
    );
  } else if (v.isClosing) {
    regels.push(
      '',
      'This is the closing. Say briefly that you have enough, that a lawyer will review it ' +
        'and that they will be in touch. Ask no new question. Promise no timeline and no outcome.',
    );
  } else if (v.candidates.length > 0) {
    regels.push(
      '',
      'Pick one of these topics to ask about, preferably the first. The hint is a direction, ' +
        'not a sentence to copy — phrase it yourself, fitting what the client just said:',
      ...v.candidates.map((c, i) => `${i + 1}. ${c.label} — ${c.hint}`),
    );
  }

  if (v.lawyerRequests && v.lawyerRequests.length > 0) {
    regels.push(
      '',
      'The lawyer is watching and wants to know this. It takes priority:',
      ...v.lawyerRequests.map((r) => `- ${r}`),
    );
  }

  if (v.interruptedPrefix) {
    regels.push(
      '',
      'The client interrupted you. This is all they heard of your previous turn:',
      `"${v.interruptedPrefix}"`,
      'Continue from what they said. Do not repeat your previous sentence verbatim.',
    );
  }

  regels.push('', 'Reply with only the words you speak. No formatting, no labels.');
  return regels.join('\n');
}

/** Taal-onafhankelijk label voor het rechtsgebied; komt in de prompt terecht. */
export function practiceAreaLabel(language: Language): string {
  return language === 'nl' ? 'arbeidsrecht' : 'employment law';
}
