import type { Metadata } from 'next';
import type { ReactNode } from 'react';
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
    <html lang="nl">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
