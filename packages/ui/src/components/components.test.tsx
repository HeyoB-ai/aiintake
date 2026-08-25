import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DossierSidebar } from './DossierSidebar';
import { DocumentUploadSection, raadCategorie } from './DocumentUploadSection';
import { DocumentViewerModal } from './DocumentViewerModal';
import { Header } from './Header';
import { TranscriptView } from './TranscriptView';
import {
  FIXTURE_BERICHTEN,
  FIXTURE_DOCUMENTEN,
  FIXTURE_DOSSIER,
  FIXTURE_FASEN_BEZIG,
  FIXTURE_FASEN_KLAAR,
} from '../fixtures';

/**
 * Deze tests bewaken geen opmaak maar afspraken.
 *
 * Wat een component eruit ziet mag veranderen; dat urgentie nooit zonder voorbehoud wordt
 * getoond, dat een scherm geen verbinding meldt die er niet is, en dat er geen feiten
 * verschijnen zolang een document nog gelezen wordt — dat mag niet veranderen. Het
 * vormgevingsprototype deed alle drie verkeerd, en dat is precies waarom ze hier staan.
 */

describe('DossierSidebar', () => {
  const props = {
    dossier: FIXTURE_DOSSIER,
    documents: FIXTURE_DOCUMENTEN,
    onSelectDocument: vi.fn(),
    onExportDossier: vi.fn(),
  };

  it('toont urgentie nooit zonder het voorbehoud erbij', () => {
    render(<DossierSidebar {...props} />);
    // urgencyCaption() draagt de disclaimer; hij hoort structureel te zijn en niet iets
    // wat een aanroeper kan vergeten.
    expect(screen.getByText(/menselijke beoordeling vereist/i)).toBeDefined();
  });

  it('toont een niet-vastgesteld feit als zodanig en niet als leegte', () => {
    render(<DossierSidebar {...props} />);
    // 'unknown' is een opslaanbare waarde: "niet vastgesteld" is een feit, geen gat.
    expect(screen.getByText('niet vastgesteld')).toBeDefined();
    expect(screen.getByText('financial_interest')).toBeDefined();
  });

  it('werkt met een leeg dossier zonder te doen alsof er iets is', () => {
    render(
      <DossierSidebar
        {...props}
        dossier={{ completeness: null, facts: [], riskFlags: [], rejected: [] }}
        documents={[]}
      />,
    );
    expect(screen.getByText('Geen signalen.')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
    expect(screen.queryByText(/menselijke beoordeling/i)).toBeNull();
  });
});

describe('Header', () => {
  const props = {
    orgName: 'Kantoor De Vries',
    documentCount: 0,
    activeTab: 'intake' as const,
    onSelectTab: vi.fn(),
    onResetSession: vi.fn(),
  };

  it('meldt geen verbinding die er niet is', () => {
    // Het prototype had "verbonden" en "eerste frame" hardgecodeerd op groen. De badges
    // horen uit de fasen te komen, anders liegt het scherm.
    const { container } = render(<Header {...props} fasen={FIXTURE_FASEN_BEZIG} />);
    const badges = Array.from(container.querySelectorAll('span')).filter(
      (el) => el.textContent === 'eerste frame',
    );
    expect(badges).toHaveLength(1);
    expect(badges[0]?.getAttribute('style')).toContain('var(--app-text-dim)');
  });

  it('gebruikt de kantoornaam uit de configuratie', () => {
    render(<Header {...props} orgName="Advocaten Jansen" fasen={FIXTURE_FASEN_KLAAR} />);
    expect(screen.getByText('Advocaten Jansen')).toBeDefined();
  });

  it('zegt letterlijk dat het een AI is', () => {
    // Dezelfde eis als in de openingsbeurt: impliciet uit "geen advocaat" is niet genoeg.
    render(<Header {...props} fasen={FIXTURE_FASEN_KLAAR} />);
    expect(screen.getByText(/AI-assistent/)).toBeDefined();
  });
});

describe('TranscriptView', () => {
  it('toont standaard geen tekstinvoer — spraak is het kanaal', () => {
    render(<TranscriptView messages={FIXTURE_BERICHTEN} isAssistentBezig={false} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('toont tekstinvoer alleen als die uitdrukkelijk is aangezet', () => {
    render(
      <TranscriptView
        messages={FIXTURE_BERICHTEN}
        isAssistentBezig={false}
        allowTextInput
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox')).toBeDefined();
  });

  it('houdt telemetrie standaard verborgen', () => {
    // De HUD is gereedschap voor ons, niet voor de cliënt.
    render(<TranscriptView messages={FIXTURE_BERICHTEN} isAssistentBezig={false} />);
    expect(screen.queryByText(/eot 284ms/)).toBeNull();

    cleanup();
    render(<TranscriptView messages={FIXTURE_BERICHTEN} isAssistentBezig={false} toonLatency />);
    expect(screen.getByText(/eot 284ms/)).toBeDefined();
  });
});

describe('DocumentUploadSection', () => {
  const props = {
    onUploadFiles: vi.fn(),
    onDeleteDocument: vi.fn(),
    onSelectDocument: vi.fn(),
  };

  it('toont geen feiten of samenvatting zolang een document nog gelezen wordt', () => {
    render(<DocumentUploadSection {...props} documents={FIXTURE_DOCUMENTEN} />);
    expect(screen.getByText(/nog geen inhoud beoordeeld/i)).toBeDefined();
  });

  it('toont de reden waarom een document mislukte', () => {
    render(<DocumentUploadSection {...props} documents={FIXTURE_DOCUMENTEN} />);
    expect(screen.getByText(/te onscherp/i)).toBeDefined();
  });

  it('raadt een categorie maar valt terug op Overig', () => {
    expect(raadCategorie('Aangetekende_Ontslagbrief.pdf')).toBe('Ontslagbrief');
    expect(raadCategorie('UWV_besluit.pdf')).toBe('UWV Dossier');
    // Geen aannemelijke gok bij twijfel: de categorie is een vindmiddel, geen bewering.
    expect(raadCategorie('scan0012.pdf')).toBe('Overig');
  });
});

describe('DocumentViewerModal', () => {
  it('toont bij elk geëxtraheerd feit waar het vandaan komt', () => {
    const doc = FIXTURE_DOCUMENTEN[0];
    if (!doc) throw new Error('fixture ontbreekt');
    render(<DocumentViewerModal document={doc} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /Geëxtraheerde feiten/ }));
    expect(screen.getByText(/bron: pagina 1, regel 3/)).toBeDefined();
  });

  it('rendert niets zonder document', () => {
    const { container } = render(<DocumentViewerModal document={null} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
