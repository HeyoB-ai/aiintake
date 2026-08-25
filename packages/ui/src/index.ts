/**
 * De ingang van het UI-pakket.
 *
 * Alleen doorgeefluik: de regels staan in urgency.ts, de thema's in themes.ts en de
 * componenten in components/. Zo kan een component uit urgency.ts putten zonder een
 * cyclus met deze ingang te maken.
 */
export * from './urgency';

export * from './themes';
export * from './types';
export { VideoWindow, type VideoWindowProps } from './components/VideoWindow';
export { TranscriptView, type TranscriptViewProps } from './components/TranscriptView';
export { Header, type HeaderProps } from './components/Header';
export { ThemeSelector, type ThemeSelectorProps } from './components/ThemeSelector';
export { ThemeProvider, useTheme } from './components/ThemeProvider';
export { DossierSidebar, type DossierSidebarProps } from './components/DossierSidebar';
export {
  DocumentUploadSection,
  raadCategorie,
  type DocumentUploadSectionProps,
} from './components/DocumentUploadSection';
export {
  DocumentViewerModal,
  type DocumentViewerModalProps,
} from './components/DocumentViewerModal';
