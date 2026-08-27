import { describe, expect, it } from 'vitest';
import { naarGeschiedenisVoorTest } from './intake-context';

/**
 * Wat er in het dossier belandt, en wat er nooit een feit mag dragen.
 *
 * ## De systeemregel
 *
 * Sinds een overgeslagen beurt een regel in het transcript krijgt, staan er berichten met rol
 * `system` tussen de beurten: *"Hier heeft de cliënt iets gezegd dat niet is verstaan."* Die
 * regel bestaat omdat een gat in het transcript anders onzichtbaar is — een advocaat leest dan
 * een doorlopend gesprek en weet niet dat er iets ontbreekt.
 *
 * Maar hij is een mededeling van ons over het gesprek, geen uitspraak van de cliënt. Gaat hij
 * als geschiedenis mee, dan wordt hij invoer voor de feitextractie en kan hij als grondslag
 * voor een `case_fact` gelden. Dezelfde uitsluiting als bij de erkenning, en om dezelfde reden:
 * alleen wat de cliënt zelf heeft gezegd, mag een feit dragen.
 *
 * ## Waarom dit een test is en niet alleen een filter
 *
 * Het filter stond er al — `role === 'client' || role === 'assistant'` — maar zonder toelichting
 * en zonder iets dat hem vasthoudt. Wie er `|| m.role === 'system'` bij zet omdat hij de
 * meldingen in de hervatting wil zien, breekt hiermee de citaatverankering zonder dat er iets
 * rood wordt. Deze test is dat rode.
 */

const RIJ = (role: string, content: string) => ({
  id: `m-${role}-${content.slice(0, 6)}`,
  role,
  content,
  interruptedAtChar: null,
  plannedQuestionKeys: [] as string[],
  createdAt: '2026-08-27T10:00:00Z',
});

describe('systeemregels dragen geen feiten', () => {
  const rijen = [
    RIJ('assistant', 'Wanneer heeft u dat te horen gekregen?'),
    RIJ('client', 'Afgelopen vrijdag, mondeling.'),
    RIJ('system', 'Hier heeft de cliënt iets gezegd dat niet is verstaan.'),
    RIJ('client', 'Ik zit sinds die dag ziek thuis.'),
  ];

  it('laat de systeemregel niet in de geschiedenis komen', () => {
    const uit = naarGeschiedenisVoorTest(rijen);
    expect(uit.map((t) => t.role)).toEqual(['assistant', 'client', 'client']);
    expect(uit.some((t) => t.content.includes('niet is verstaan'))).toBe(false);
  });

  it('houdt de beurten die er wél toe doen compleet', () => {
    // Zonder deze eis zou een filter dat álles weggooit ook slagen, en dan is de uitsluiting
    // niet te onderscheiden van een kapotte geschiedenis.
    const uit = naarGeschiedenisVoorTest(rijen);
    expect(uit).toHaveLength(3);
    expect(uit[1]!.content).toBe('Afgelopen vrijdag, mondeling.');
    expect(uit[2]!.content).toBe('Ik zit sinds die dag ziek thuis.');
  });

  it('houdt de volgorde vast', () => {
    // De extractie leest een dialoog; wisselt de volgorde, dan hoort een antwoord bij de
    // verkeerde vraag en verankert een citaat aan iets wat er niet is gezegd.
    const uit = naarGeschiedenisVoorTest(rijen);
    expect(uit[0]!.content).toBe('Wanneer heeft u dat te horen gekregen?');
  });
});
