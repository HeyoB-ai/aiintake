import type { ContactVeld } from '@intake/domain';

/**
 * Wat de bezoeker te zien krijgt als het starten van een gesprek niet lukt.
 *
 * Los van `actions.ts` omdat daar `'use server'` bovenaan staat en de hele Supabase-keten
 * eraan hangt. Deze regel is puur — een melding uit een fout — en hoort te testen te zijn
 * zonder database.
 */

export interface GesprekMislukt {
  readonly ok: false;
  readonly fout: string;
  /**
   * Welk invoerveld de fout veroorzaakte, als het er een is.
   *
   * Bestaat zodat het scherm de melding onder het juiste veld kan zetten in plaats van in de
   * balk onderaan. Die balk is voor storingen; een typefout is geen storing, en hem daar tonen
   * is precies waardoor iemand denkt dat de app stuk is.
   */
  readonly veld?: ContactVeld;
}

/**
 * Vertaalt een weigering van `create_public_intake` naar iets waar de bezoeker mee verder kan.
 *
 * ## Waarom dit los staat
 *
 * Om er een test op te kunnen zetten zonder een database. De regel zelf is het punt: drie
 * soorten weigering die niet op één hoop horen.
 *
 * De database valideert de invoer óók — dat oordeel hoort daar, zodat een tweede client er
 * niet omheen kan. Maar als zij een e-mailadres afkeurt, is dat een typefout van de cliënt en
 * geen storing. Dat kwam uit als "Het gesprek kon niet worden gestart", dezelfde zin als bij
 * een kapotte functiesignatuur — en dat is precies waarom er voor een typefout in het
 * functielog moest worden gekeken.
 *
 * Wat hier NIET wordt doorgegeven: de melding van de database zelf. Die is voor het log. Een
 * bezoeker heeft niets aan "22023", en wij hebben er niets bij te winnen om te verraden hoe de
 * controle werkt.
 */
export function meldingVoorDbFout(error: {
  message: string;
  code?: string | undefined;
}): GesprekMislukt {
  const bericht = error.message;

  if (bericht.includes('e-mailadres')) {
    return { ok: false, veld: 'clientEmail', fout: 'Dit lijkt geen geldig e-mailadres.' };
  }
  if (bericht.includes('een naam is vereist')) {
    return { ok: false, veld: 'clientName', fout: 'Vul uw voor- en achternaam in.' };
  }
  if (bericht.includes('te veel intakepogingen')) {
    // Het venster is een uur (`p_max_per_hour`, `date_trunc('hour', now())`). Hier stond
    // "een kwartier"; wie dat las kwam terug en werd opnieuw geweigerd, zonder te weten
    // waarom. Geen getal noemen dat niet uit de regel volgt.
    return {
      ok: false,
      fout: 'Er zijn te veel pogingen vanaf dit adres. Probeer het over een uur opnieuw.',
    };
  }
  if (error.code === 'P0002' || bericht.includes('onbekende organisatie')) {
    /*
     * Geen storing maar een verkeerde link. Zonder eigen melding gaat iemand met een
     * verouderde QR-code net zo lang opnieuw proberen als bij een echte storing.
     */
    return {
      ok: false,
      fout: 'Deze link hoort niet bij een bestaand kantoor. Controleer de link of vraag er een nieuwe op.',
    };
  }

  return { ok: false, fout: 'Het gesprek kon niet worden gestart. Probeer het later opnieuw.' };
}
