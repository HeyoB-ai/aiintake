import type { Metadata } from 'next';
import { ConceptTekst, Kop, Alinea, Lijst } from '../juridisch';

export const metadata: Metadata = {
  title: 'AI-verklaring (concept)',
};

/**
 * De AI-verklaring.
 *
 * Dezelfde reden als bij /privacy: het toestemmingsscherm legt
 * `consent_records.ai_disclosure_version` vast en linkte naar een route die niet bestond.
 *
 * Waarom dit een eigen tekst is en geen kopje in de privacyverklaring: op het
 * toestemmingsscherm staan twee losse vinkjes, en die zijn bewust gescheiden. Het ene gaat
 * over wat er met je gegevens gebeurt, het andere over met wie je praat. Eén akkoord voor
 * allebei zou geen van beide zijn — en dan hoort er ook niet één document onder te liggen.
 *
 * Skelet, niet vastgesteld. Zie de toelichting in app/privacy/page.tsx.
 */
export default function AiDisclosurePagina() {
  return (
    <ConceptTekst titel="U spreekt met een AI-assistent" versie="v1">
      <Alinea>
        Het intakegesprek wordt gevoerd door een AI-assistent. Dat is geen medewerker van het
        kantoor en geen advocaat.
      </Alinea>

      <Kop>Wat de assistent doet</Kop>
      <Lijst
        items={[
          'Zij stelt vragen over uw situatie en luistert naar uw antwoord.',
          'Zij legt vast wat u vertelt en ordent dat tot een dossier.',
          'Zij geeft dat dossier door aan een advocaat van het kantoor.',
        ]}
      />

      <Kop>Wat de assistent niet doet</Kop>
      <Lijst
        items={[
          'Zij geeft geen juridisch advies.',
          'Zij doet geen uitspraak over uw kansen of over wat u zou moeten doen.',
          'Zij neemt geen beslissing over uw zaak. Dat doet een advocaat, na het gesprek.',
          'Zij beoordeelt u niet op uw gezichtsuitdrukking of stemgeluid.',
        ]}
      />

      <Kop>Dat het een computer is, kan misgaan</Kop>
      <Alinea>
        Een AI-assistent kan iets verkeerd verstaan of verkeerd samenvatten. Daarom staat bij elk
        vastgelegd feit de zin waarop het berust, zodat een advocaat kan nazien of het klopt. Merkt
        u tijdens het gesprek dat er iets verkeerd is begrepen, zeg het dan — u kunt de assistent
        onderbreken.
      </Alinea>

      <Kop>U kunt stoppen</Kop>
      <Alinea>
        U kunt het gesprek op elk moment beëindigen met de knop op het scherm. Wilt u liever een
        mens spreken, neem dan rechtstreeks contact op met het kantoor; deze intake is een
        hulpmiddel en geen voorwaarde.
      </Alinea>

      <Alinea>
        Wat er met uw gegevens gebeurt, staat in de{' '}
        <a href="/privacy" className="underline">
          privacyverklaring
        </a>
        .
      </Alinea>
    </ConceptTekst>
  );
}
