import { describe, expect, it } from 'vitest';
import { meldingVoorDbFout } from './foutmeldingen';

/**
 * Een invoerfout mag er niet uitzien als een storing.
 *
 * Aanleiding: een ongeldig e-mailadres op een iPhone leverde "Het gesprek kon niet worden
 * gestart" op — dezelfde zin als bij een kapotte functiesignatuur, een onbekende organisatie
 * of een netwerkfout. De bezoeker dacht dat de app stuk was; de oorzaak stond alleen in het
 * functielog.
 *
 * De meldingen hieronder zijn niet cosmetisch. Ze bepalen of iemand het opnieuw probeert
 * (typefout), zijn link controleert (verkeerd kantoor), of een uur wacht (rate limiter).
 */

describe('een weigering van de database uitleggen', () => {
  it('wijst een afgekeurd e-mailadres aan het veld', () => {
    const uit = meldingVoorDbFout({ message: 'het e-mailadres lijkt niet te kloppen' });
    expect(uit.veld).toBe('clientEmail');
    expect(uit.fout).toContain('e-mailadres');
  });

  it('wijst een ontbrekende naam aan het veld', () => {
    expect(meldingVoorDbFout({ message: 'een naam is vereist' }).veld).toBe('clientName');
  });

  it('zegt bij de rate limiter hoe lang, en noemt het juiste venster', () => {
    /*
     * Het venster is een uur (`date_trunc('hour', now())`). Hier stond ooit "een kwartier";
     * wie dat las kwam terug en werd opnieuw geweigerd, zonder te weten waarom.
     */
    const uit = meldingVoorDbFout({ message: 'te veel intakepogingen vanaf dit adres' });
    expect(uit.fout).toContain('uur');
    expect(uit.veld).toBeUndefined();
  });

  it('behandelt een onbekend kantoor als een verkeerde link', () => {
    // Geen storing. Zonder eigen melding blijft iemand met een verouderde QR-code net zo lang
    // opnieuw proberen als bij een echte storing.
    const uit = meldingVoorDbFout({ message: 'onbekende organisatie', code: 'P0002' });
    expect(uit.fout).toContain('link');
    expect(uit.veld).toBeUndefined();
  });

  it('houdt een echte storing algemeen', () => {
    /*
     * Dit is de tak die moest blijven. Een kapotte functiesignatuur (PGRST202) of een
     * rechtenfout verraadt hoe het systeem in elkaar zit; die hoort vaag te blijven en
     * uitsluitend in het log precies te zijn.
     */
    const uit = meldingVoorDbFout({
      message: 'Could not find the function public.create_public_intake',
      code: 'PGRST202',
    });
    expect(uit.fout).toContain('kon niet worden gestart');
    expect(uit.veld).toBeUndefined();
  });

  it('lekt de melding van de database niet naar de bezoeker', () => {
    // Anders staat er alsnog "22023" of een functiesignatuur op het scherm van een cliënt.
    const rauw = 'PGRST202: Could not find the function public.create_public_intake(p_org_slug)';
    expect(meldingVoorDbFout({ message: rauw, code: 'PGRST202' }).fout).not.toContain('PGRST');
  });
});
