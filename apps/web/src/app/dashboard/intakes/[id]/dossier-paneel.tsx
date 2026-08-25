'use client';

import { useState } from 'react';
import {
  DocumentViewerModal,
  DossierSidebar,
  type DocumentItem,
  type DossierState,
} from '@intake/ui';

/**
 * De clientkant van het dossierpaneel.
 *
 * `DossierSidebar` en `DocumentViewerModal` hebben een klik nodig — een document openen —
 * en dus staat er een dun clientcomponent omheen. De gegevens komen van de server; hier
 * gebeurt niets dan het onthouden wélk document open staat.
 *
 * Exporteren staat er nog niet in. De knop bestaat in de component en hoort een echt
 * dossier-export op te leveren; hem nu op een `alert` of een halve download laten uitkomen
 * zou een advocaat laten denken dat hij iets heeft dat hij niet heeft.
 */

export function DossierPaneel({
  dossier,
  documents,
  intakeId,
}: {
  readonly dossier: DossierState;
  readonly documents: readonly DocumentItem[];
  readonly intakeId: string;
}) {
  const [gekozen, setGekozen] = useState<DocumentItem | null>(null);

  return (
    <>
      <div
        /*
         * Geen `h-fit` en geen `overflow-hidden`.
         *
         * `height: fit-content` om een kind met een eigen scrollgebied is de combinatie
         * waar browsers uiteenlopen: de hoogte kan inklappen en dan schuift wat eronder
         * staat eroverheen. In één kolom heeft de zijbalk dat scrollgebied niet meer
         * nodig, en dan is een gewone blokhoogte het veiligst.
         */
        className="overflow-hidden rounded-lg border lg:h-fit"
        style={{ borderColor: 'var(--border)' }}
      >
        <DossierSidebar
          dossier={dossier}
          documents={documents}
          onSelectDocument={setGekozen}
          onExportDossier={() => {
            // Bewust nog niet bedraad; zie de kop.
            console.info(`export van dossier ${intakeId} is nog niet gebouwd`);
          }}
        />
      </div>
      <DocumentViewerModal document={gekozen} onClose={() => setGekozen(null)} />
    </>
  );
}
