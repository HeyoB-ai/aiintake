/*
 * Presentatieregels voor urgentie en volledigheid.
 *
 * Dit stond in index.ts, en de componenten importeerden het daarvandaan. Omdat index.ts
 * diezelfde componenten exporteert, was dat een cyclus: `index -> DossierSidebar -> index`.
 * Dependency-cruiser ving hem meteen. Een cyclus is hier geen theoretisch bezwaar — hij
 * bepaalt in welke volgorde modules initialiseren, en dat is precies het soort fout dat
 * zich pas in een productiebundel laat zien.
 *
 * Deze module hangt nergens van af behalve het domein, en dat maakt hem de bodem van de
 * stapel.
 */
import type { UrgencyLevel } from '@intake/domain';

/**
 * Gedeelde presentatielogica. Componenten volgen in Fase 3 (dashboard) en Fase 1
 * (gespreksscherm); wat hier staat, zijn de regels die op meer dan één plek gelden.
 */

export const URGENCY_STYLES: Record<
  UrgencyLevel,
  { fg: string; bg: string; label: { nl: string; en: string } }
> = {
  LOW: {
    fg: 'var(--urgency-low)',
    bg: 'var(--urgency-low-bg)',
    label: { nl: 'Laag', en: 'Low' },
  },
  MEDIUM: {
    fg: 'var(--urgency-medium)',
    bg: 'var(--urgency-medium-bg)',
    label: { nl: 'Midden', en: 'Medium' },
  },
  HIGH: {
    fg: 'var(--urgency-high)',
    bg: 'var(--urgency-high-bg)',
    label: { nl: 'Hoog', en: 'High' },
  },
  CRITICAL: {
    fg: 'var(--urgency-critical)',
    bg: 'var(--urgency-critical-bg)',
    label: { nl: 'Kritiek', en: 'Critical' },
  },
};

/**
 * Urgentie wordt nóóit als vaststelling gepresenteerd.
 *
 * Het systeem signaleert een mogelijke termijn; of die termijn juridisch klopt, is
 * een oordeel dat alleen een jurist mag vellen. Deze functie is de enige toegestane
 * manier om een urgentieniveau in tekst om te zetten.
 */
export function urgencyCaption(level: UrgencyLevel, language: 'nl' | 'en'): string {
  const name = URGENCY_STYLES[level].label[language];
  return language === 'nl'
    ? `${name} — mogelijk urgente termijn, menselijke beoordeling vereist`
    : `${name} — possibly urgent deadline, human review required`;
}

export function formatCompleteness(value: number | null): string {
  if (value === null) return '—';
  return `${Math.round(value * 100)}%`;
}
