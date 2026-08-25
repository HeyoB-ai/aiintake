/**
 * De vier thema's die het kantoor kan kiezen.
 *
 * Dit is een kantoorinstelling, geen voorkeur van de cliënt: het gespreksscherm draagt de
 * uitstraling van het kantoor dat de intake aanbiedt. De keuze staat als `data-theme` op
 * het root-element; de kleuren zelf staan in themes.css.
 *
 * De systeemvoorkeur (`prefers-color-scheme`) telt alleen mee zolang er géén thema is
 * gezet. Zodra het kantoor kiest, wint die keuze — anders zou dezelfde intake er bij twee
 * cliënten anders uitzien.
 */

export const THEME_IDS = [
  'modern-light',
  'minimal-slate',
  'corporate-navy',
  'sophisticated-dark',
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = 'modern-light';

export interface ThemeOption {
  readonly id: ThemeId;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly badge: string;
  readonly isDark: boolean;
  /** Vier kleuren voor het voorbeeldblokje in de kiezer. */
  readonly preview: {
    readonly bg: string;
    readonly card: string;
    readonly primary: string;
    readonly text: string;
  };
}

export const THEMES: readonly ThemeOption[] = [
  {
    id: 'modern-light',
    name: 'Helder Zakelijk',
    category: 'Modern Light',
    description:
      'Fris, helder wit met professioneel marineblauw, strakke typografie en rustige kaarten.',
    badge: 'Aanbevolen voor advocatuur',
    isDark: false,
    preview: { bg: '#f8fafc', card: '#ffffff', primary: '#2563eb', text: '#0f172a' },
  },
  {
    id: 'minimal-slate',
    name: 'Minimalist SaaS',
    category: 'Linear / Apple stijl',
    description: 'Ultrastrak met zachte grijstinten, zuivere lijnen en moderne typografie.',
    badge: 'Ultra-clean',
    isDark: false,
    preview: { bg: '#fafafa', card: '#ffffff', primary: '#0f172a', text: '#18181b' },
  },
  {
    id: 'corporate-navy',
    name: 'Executive Navy',
    category: 'Midnight cockpit',
    description: 'Donkerblauw met heldere ijsblauwe accenten en hoge contrasten.',
    badge: 'Donker',
    isDark: true,
    preview: { bg: '#0a0f1d', card: '#111827', primary: '#38bdf8', text: '#f1f5f9' },
  },
  {
    id: 'sophisticated-dark',
    name: 'Obsidiaan & Goud',
    category: 'Classic luxury',
    description: 'Diepzwart met warme gouden accenten en klassieke serif-koppen.',
    badge: 'Warm goud',
    isDark: true,
    preview: { bg: '#080808', card: '#121212', primary: '#d4af37', text: '#e5e5e5' },
  },
];

export function isThemeId(waarde: unknown): waarde is ThemeId {
  return typeof waarde === 'string' && (THEME_IDS as readonly string[]).includes(waarde);
}

/**
 * Zoekt een thema op, en valt terug op het standaardthema.
 *
 * Geen `!` en geen aanname dat de lijst niet leeg is: met `noUncheckedIndexedAccess` is
 * `THEMES[0]` mogelijk `undefined`, en een kapotte thema-id hoort geen wit scherm te geven.
 */
export function themeById(id: string | null | undefined): ThemeOption {
  const gevonden = THEMES.find((t) => t.id === id);
  if (gevonden) return gevonden;
  const standaard = THEMES.find((t) => t.id === DEFAULT_THEME);
  if (!standaard) throw new Error('THEMES bevat het standaardthema niet');
  return standaard;
}
