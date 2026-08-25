import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DEFAULT_THEME, ThemeProvider } from '@intake/ui';
import './globals.css';

export const metadata: Metadata = {
  title: 'Intake — juridische intake-assistent',
  description:
    'Digitale intake voor advocatenkantoren. De assistent verzamelt en structureert; ' +
    'de jurist beoordeelt.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /*
     * `data-theme` staat al in de server-HTML.
     *
     * Zonder dat krijgt een donker thema één frame in het licht voordat React het
     * attribuut zet. ThemeProvider haalt daarna de opgeslagen voorkeur in.
     */
    <html lang="nl" data-theme={DEFAULT_THEME}>
      <body className="min-h-screen">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
