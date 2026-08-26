import type { Metadata } from 'next';
import { ConceptTekst, Kop, Alinea, Lijst } from '../juridisch';

export const metadata: Metadata = {
  title: 'Privacyverklaring (concept)',
};

/**
 * De privacyverklaring.
 *
 * ## Waarom dit bestand er is
 *
 * Het toestemmingsscherm liet de cliënt akkoord gaan met "de privacyverklaring", legde het
 * versienummer vast in `consent_records.privacy_policy_version`, en linkte naar `/privacy`
 * — een route die niet bestond. Er werd dus toestemming geregistreerd voor een document dat
 * een 404 gaf. Dat is erger dan geen link: het ziet er in de database uit als een geldige
 * vastlegging.
 *
 * ## Wat dit wel en niet is
 *
 * Dit is een skelet dat dekt wat het systeem feitelijk vastlegt en aan wie het dat
 * doorgeeft. Het is geen juridische tekst en het is niet vastgesteld. Wat er hoort te
 * staan — grondslag, betrokkenenrechten, bewaartermijnen per categorie, de
 * verwerkersovereenkomsten — is aan het kantoor. Daarom staat er op elke pagina een
 * zichtbare conceptmarkering; die hoort er pas af als iemand met de bevoegdheid ernaar
 * heeft gekeken.
 *
 * De genoemde termijnen komen uit `RetentionPolicySchema` in @intake/domain en zijn de
 * standaarden in code, niet een belofte van het kantoor. Wijkt een kantoor daarvan af in
 * `organizations.retention_policy`, dan klopt deze tekst voor dat kantoor niet meer — nog
 * een reden waarom hij per kantoor vastgesteld hoort te worden.
 */
export default function PrivacyPagina() {
  return (
    <ConceptTekst titel="Privacyverklaring" versie="v1">
      <Alinea>
        Deze verklaring beschrijft welke gegevens worden vastgelegd wanneer u een intake doet via de
        AI-intake-assistent, waarvoor ze worden gebruikt en hoe lang ze bewaard blijven.
        Verwerkingsverantwoordelijke is het advocatenkantoor dat de intake aanbiedt.
      </Alinea>

      <Kop>Welke gegevens u zelf opgeeft</Kop>
      <Lijst
        items={[
          'Uw naam — nodig om uw dossier te kunnen aanleggen en u aan te spreken.',
          'Uw e-mailadres en/of telefoonnummer — nodig om contact met u op te nemen over uw ' +
            'zaak. Eén van beide is verplicht, allebei mag.',
          'Wat u tijdens het gesprek vertelt over uw situatie.',
        ]}
      />

      <Kop>Wat er tijdens het gesprek wordt vastgelegd</Kop>
      <Alinea>
        Uw spraak wordt omgezet naar tekst en die tekst wordt bewaard als transcript. Uit dat
        transcript worden feiten over uw zaak afgeleid, met daarbij de zin waarop elk feit berust,
        zodat een advocaat kan nazien waar iets vandaan komt.
      </Alinea>
      <Alinea>
        <strong>Beeld en geluid worden niet opgeslagen.</strong> Het camerabeeld van uw eigen
        apparaat blijft op uw apparaat en wordt niet verstuurd. Het geluid gaat door de keten om
        omgezet te worden naar tekst; er wordt geen opname van bewaard.
      </Alinea>
      <Alinea>
        Van uw IP-adres wordt uitsluitend een onomkeerbare versleutelde waarde bewaard, om te
        voorkomen dat één bezoeker het systeem overbelast. Het adres zelf wordt niet opgeslagen.
      </Alinea>

      <Kop>Hoe lang</Kop>
      <Lijst
        items={[
          'Transcript en vastgelegde feiten: 365 dagen.',
          'Documenten die u meestuurt: 365 dagen.',
          'Een intake die wordt afgewezen: 90 dagen.',
          'Beeld en geluid: niet bewaard.',
        ]}
      />
      <Alinea>
        Dit zijn de standaardtermijnen van het systeem. Het kantoor kan hiervan afwijken; de termijn
        die voor u geldt staat in de vastgestelde versie van deze verklaring.
      </Alinea>

      <Kop>Wie de gegevens verwerkt</Kop>
      <Alinea>
        Om het gesprek te kunnen voeren worden gegevens verwerkt door de volgende partijen. Met elk
        van hen hoort een verwerkersovereenkomst te bestaan.
      </Alinea>
      <Lijst
        items={[
          'Supabase — opslag van het dossier, in de Europese Unie.',
          'Deepgram — omzetten van spraak naar tekst.',
          'Cartesia — omzetten van tekst naar spraak.',
          'Anthropic — het taalmodel dat het gesprek voert en de feiten afleidt.',
          'Anam — het sprekende gezicht dat u in beeld ziet.',
          'LiveKit — het transport van beeld en geluid.',
          'Netlify en Railway — hosting van de website en de gespreksdienst.',
        ]}
      />

      <Kop>Uw rechten</Kop>
      <Alinea>
        U kunt inzage vragen in wat er over u is vastgelegd, en verzoeken om correctie of
        verwijdering. Ook kunt u een klacht indienen bij de Autoriteit Persoonsgegevens. Het adres
        waarop u dit kunt doen, staat in de vastgestelde versie van deze verklaring.
      </Alinea>

      <Kop>Wat de assistent niet is</Kop>
      <Alinea>
        U spreekt met een AI-assistent en niet met een advocaat. De assistent geeft geen juridisch
        advies en doet geen uitspraak over uw zaak; zij legt vast wat u vertelt, zodat een advocaat
        het daarna kan beoordelen. Zie ook de{' '}
        <a href="/ai-disclosure" className="underline">
          AI-verklaring
        </a>
        .
      </Alinea>
    </ConceptTekst>
  );
}
