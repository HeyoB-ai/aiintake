'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, isThemeId, type ThemeId } from '../themes';

/**
 * Houdt `data-theme` op het root-element bij.
 *
 * De keuze staat in `localStorage` en niet in een cookie: het is een voorkeur van het
 * apparaat waarop iemand werkt, niet iets waar de server een beslissing op neemt.
 *
 * ## Waarom de server alvast een thema zet
 *
 * `layout.tsx` zet `data-theme` op het `<html>`-element voordat React draait. Zonder dat
 * krijg je bij een donker thema één frame in het licht — een flits die bij een
 * intakegesprek net zo storend is als een verkeerde kleur. Deze provider corrigeert daarna
 * naar de opgeslagen voorkeur.
 */

interface ThemeContext {
  readonly theme: ThemeId;
  readonly setTheme: (id: ThemeId) => void;
}

const Context = createContext<ThemeContext | null>(null);

const SLEUTEL = 'intake:theme';

export function ThemeProvider({
  children,
  initialTheme = DEFAULT_THEME,
}: {
  readonly children: ReactNode;
  readonly initialTheme?: ThemeId;
}) {
  const [theme, setThemeState] = useState<ThemeId>(initialTheme);

  useEffect(() => {
    // Alleen bij het opstarten: de opgeslagen voorkeur inhalen. Een onbekende waarde —
    // bijvoorbeeld een thema dat is hernoemd — wordt genegeerd in plaats van doorgezet.
    const opgeslagen = window.localStorage.getItem(SLEUTEL);
    if (isThemeId(opgeslagen) && opgeslagen !== theme) setThemeState(opgeslagen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const setTheme = useCallback((id: ThemeId) => {
    setThemeState(id);
    try {
      window.localStorage.setItem(SLEUTEL, id);
    } catch {
      // Privémodus of een volle opslag mag geen themawissel tegenhouden.
    }
  }, []);

  return <Context.Provider value={{ theme, setTheme }}>{children}</Context.Provider>;
}

export function useTheme(): ThemeContext {
  const context = useContext(Context);
  if (!context) throw new Error('useTheme() vraagt een <ThemeProvider> erboven');
  return context;
}
