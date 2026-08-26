import { conversationPrompt } from './conversation';
import { ladingPrompt } from './lading';
import { extractionPrompt } from './extraction';

/**
 * Het promptregister.
 *
 * Eén plek waar staat welke sjablonen er zijn en op welke versie ze staan. Dat is geen
 * administratie om de administratie: elke `llm_calls`-rij bewaart sleutel én versie, en
 * bij een intake die tot een juridische beoordeling leidt, moet je maanden later kunnen
 * reconstrueren met welke instructie het model werkte. "We hebben de prompt sindsdien
 * aangepast" is dan geen antwoord.
 *
 * Daarom ook de controle onderaan: twee sjablonen met dezelfde sleutel zouden die
 * reconstructie stilzwijgend onmogelijk maken.
 */

export const PROMPTS = {
  conversation: conversationPrompt,
  extraction: extractionPrompt,
  lading: ladingPrompt,
} as const;

export type PromptName = keyof typeof PROMPTS;

/** Sleutel en versie van elk sjabloon; handig voor een health-endpoint en voor tests. */
export function promptVersions(): ReadonlyArray<{
  name: string;
  key: string;
  version: number;
  purpose: string;
}> {
  return Object.entries(PROMPTS).map(([name, t]) => ({
    name,
    key: t.key,
    version: t.version,
    purpose: t.purpose,
  }));
}

// Dubbele sleutels zijn een reconstructiefout die pas maanden later pijn doet, dus
// vangen we hem bij het laden van de module.
const sleutels = Object.values(PROMPTS).map((t) => t.key);
const dubbel = sleutels.filter((k, i) => sleutels.indexOf(k) !== i);
if (dubbel.length > 0) {
  throw new Error(`Promptregister bevat dubbele sleutels: ${[...new Set(dubbel)].join(', ')}`);
}
