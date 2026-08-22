/**
 * Zinsgewijs flushen naar TTS.
 *
 * Na "geen JSON op het hot path" is dit de grootste latencywinst in de hele lus. Wacht
 * je op de complete respons, dan betaal je de generatietijd van élke zin voordat er
 * één klank klinkt; bij een antwoord van drie zinnen scheelt flushen ~600 ms.
 *
 * De regel: flush op een zinsafsluiting, of op 120 tekens als er geen komt. Die tweede
 * grens is er voor modellen die af en toe een lange bijzin zonder leesteken produceren
 * — zonder die grens blijft zo'n beurt hangen tot het einde.
 *
 * Bewust geen NLP: afkortingen als "mr." of "art. 7:669" leveren hooguit een iets te
 * vroege flush op, en dat is hoorbaar als een minieme pauze. Een gemiste flush kost
 * honderden milliseconden. De asymmetrie bepaalt de keuze.
 */

const SENTENCE_ENDINGS = new Set(['.', '?', '!']);
export const MAX_CHARS_BEFORE_FLUSH = 120;

export class SentenceFlusher {
  private buffer = '';

  constructor(
    private readonly onSentence: (sentence: string) => void,
    private readonly maxChars: number = MAX_CHARS_BEFORE_FLUSH,
  ) {}

  /** Voegt een stukje modeluitvoer toe en flusht wat compleet is. */
  push(chunk: string): void {
    for (const char of chunk) {
      this.buffer += char;

      if (SENTENCE_ENDINGS.has(char)) {
        // Een leesteken gevolgd door meer tekst in dezelfde chunk is prima: we flushen
        // hier en de rest komt in de volgende zin terecht.
        this.flush();
      } else if (this.buffer.length >= this.maxChars && char === ' ') {
        // Alleen op een spatie afkappen, anders knip je midden in een woord en klinkt
        // de synthese onnatuurlijk.
        this.flush();
      }
    }
  }

  /** Stuurt de rest weg. Aanroepen als de modelstream klaar is. */
  end(): void {
    this.flush();
  }

  private flush(): void {
    const text = this.buffer.trim();
    this.buffer = '';
    if (text.length > 0) this.onSentence(text);
  }

  /** Weggooien zonder te flushen. Voor barge-in: dit hoort de cliënt niet meer. */
  discard(): void {
    this.buffer = '';
  }

  get pending(): string {
    return this.buffer;
  }
}
