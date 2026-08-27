'use client';

import { alleenTijd, type Tijdzone } from '@intake/domain';
import { TranscriptView, type ConversationMessage } from '@intake/ui';

/**
 * Het transcript zoals de advocaat het leest.
 *
 * Dezelfde component als in het gespreksscherm, met twee verschillen die uit de context
 * volgen: geen tekstinvoer — dit gesprek is voorbij — en de afgebroken beurten worden
 * zichtbaar gemaakt.
 *
 * ## Waarom een afgebroken beurt ertoe doet
 *
 * `interrupted_at_char` betekent dat de cliënt door de assistent heen praatte. Wat er ná
 * dat teken staat is nooit uitgesproken. Zonder dat te tonen leest een advocaat een vraag
 * die de cliënt niet gehoord heeft, en dan lijkt het antwoord daarop nergens op te slaan —
 * of erger, hij rekent de cliënt aan dat hij de vraag ontweek.
 */

export function Transcript({
  berichten,
  zone,
}: {
  readonly berichten: readonly {
    readonly id: string;
    readonly role: 'assistant' | 'client' | 'system';
    readonly content: string;
    readonly intended_content: string | null;
    readonly interrupted_at_char: number | null;
    readonly created_at: string;
  }[];
  /*
   * De zone komt van de server mee en wordt hier niet bepaald.
   *
   * Dit is een clientcomponent. `toLocaleTimeString` zonder zone nam hier de zone van de
   * browser, terwijl de servercomponent ernaast die van Netlify nam — UTC. Dezelfde
   * uitdrukking, twee antwoorden, twee uur uit elkaar. Zie tijd.ts.
   */
  readonly zone: Tijdzone;
}) {
  if (berichten.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        Er is nog geen gesprek gevoerd.
      </p>
    );
  }

  const berichtenVoorWeergave: ConversationMessage[] = berichten.map((b) => ({
    id: b.id,
    speaker: b.role === 'assistant' ? 'ASSISTENT' : b.role === 'client' ? 'U' : 'SYSTEEM',
    text:
      b.interrupted_at_char !== null && b.intended_content
        ? `${b.content}… (onderbroken; de cliënt hoorde de rest niet: “${b.intended_content.slice(b.interrupted_at_char)}”)`
        : b.content,
    timestamp: alleenTijd(b.created_at, zone),
  }));

  /*
   * Geen hoogte om de component heen.
   *
   * Hier stond `max-h-[640px]`. Dat begrenst de doos maar knipt niets — `overflow` staat
   * op `visible` — en het transcript kreeg er een `h-full` in. Op Safari tekende de inhoud
   * daardoor buiten de doos, precies over het auditlog eronder. De begrenzing zit nu in de
   * component zelf, op de berichtenlijst, waar hij mét `overflow-y-auto` staat.
   */
  return <TranscriptView messages={berichtenVoorWeergave} isAssistentBezig={false} />;
}
