import { describe, expect, it } from 'vitest';
import {
  ALLE_WANHOOP_TEKSTEN,
  VERWIJZING_ACUUT,
  VERWIJZING_GELDZORGEN,
  wanhoopReactie,
} from './wanhoop';

/**
 * Het wanhoopspad. Deze tests bewaken wat er níét in mag staan.
 *
 * De verwijzingen zelf zijn nagezocht op de site van de dienst; dat is geen testwerk maar
 * een controle die een mens doet. Wat hier wordt vastgelegd is de vorm: geen vraag, geen
 * juridisch oordeel, geen belofte, geen gevoel dat de cliënt niet heeft geuit.
 */

describe('vorm van de reactie', () => {
  it('zwijgt als er geen wanhoop is', () => {
    expect(wanhoopReactie('geen')).toBeNull();
  });

  it('stelt nooit een vraag', () => {
    // Doorvragen op wanhoop door een systeem dat niet kan helpen is schadelijk. Dit is de
    // regel die dat afdwingt, niet een instructie in een prompt.
    for (const tekst of ALLE_WANHOOP_TEKSTEN) expect(tekst).not.toContain('?');
  });

  it('verwijst niet naar de advocaat', () => {
    for (const tekst of ALLE_WANHOOP_TEKSTEN) {
      expect(tekst.toLowerCase()).not.toContain('advocaat van');
      expect(tekst.toLowerCase()).not.toContain('lawyer will');
    }
  });

  it('benoemt geen gevoel en geen oordeel over de zaak', () => {
    for (const tekst of ALLE_WANHOOP_TEKSTEN) {
      for (const woord of ['boos', 'verdrietig', 'onterecht', 'kansrijk', 'angry', 'unfair']) {
        expect(tekst.toLowerCase()).not.toContain(woord);
      }
    }
  });

  it('zegt dat de assistent hier niet mee kan helpen', () => {
    // Geen belofte die niemand kan waarmaken. De assistent is een intakeassistent.
    const acuut = wanhoopReactie('acuut')!.tekst;
    expect(acuut).toContain('AI-assistent');
    expect(acuut.toLowerCase()).toContain('niet mee helpen');
  });
});

describe('de verwijzingen', () => {
  it('stuurt acute nood naar 113 en niet naar Geldfit', () => {
    const r = wanhoopReactie('acuut')!;
    expect(r.tekst).toContain(VERWIJZING_ACUUT.telefoon);
    expect(r.tekst).toContain('113.nl');
    expect(r.tekst).not.toContain(VERWIJZING_GELDZORGEN.telefoon);
    expect(r.niveau).toBe('CRITICAL');
  });

  it('stuurt geldzorgen naar Geldfit, mét openingstijden', () => {
    const r = wanhoopReactie('geldzorgen')!;
    expect(r.tekst).toContain('0800-8115');
    // De tijden staan er met opzet bij: iemand die 's avonds belt en niemand krijgt, is
    // slechter af dan iemand die weet dat hij morgen moet bellen.
    expect(r.tekst).toContain('maandag tot en met vrijdag');
    expect(r.niveau).toBe('HIGH');
  });

  it('belooft geen bereikbaarheid die we niet hebben nagezocht', () => {
    // Op 113.nl stonden geen openingstijden, dus beloven we ze niet.
    expect(VERWIJZING_ACUUT.bereikbaarheid).toBeNull();
    expect(wanhoopReactie('acuut')!.tekst).not.toContain('24');
    // Ook geen omschrijving die hetzelfde belooft zonder een getal te noemen.
    for (const tekst of ALLE_WANHOOP_TEKSTEN) {
      expect(tekst.toLowerCase()).not.toContain('dag en nacht');
      expect(tekst.toLowerCase()).not.toContain('day and night');
      expect(tekst.toLowerCase()).not.toContain('altijd bereikbaar');
    }
  });

  it('geeft elke soort een eigen regelsleutel voor het dossier', () => {
    expect(wanhoopReactie('acuut')!.regelKey).not.toBe(wanhoopReactie('geldzorgen')!.regelKey);
  });
});
