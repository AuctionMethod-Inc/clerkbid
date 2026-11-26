"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  PREFERS_MORE_CONTRAST_QUERY,
  applyDisplayPrefsToDocument,
  readColorScheme,
  readFontScale,
  readHighContrastPreference,
  resolveHighContrast,
  systemPrefersMoreContrast,
  writeColorScheme,
  writeFontScale,
  writeHighContrast,
  type ColorSchemePreference,
  type FontScaleKey,
} from "@/lib/displayPrefs";

type DisplayPrefsValue = {
  colorScheme: ColorSchemePreference;
  fontScale: FontScaleKey;
  /** Effective value: the user's choice, or the device setting when unset. */
  highContrast: boolean;
  setColorScheme: (v: ColorSchemePreference) => void;
  setFontScale: (v: FontScaleKey) => void;
  setHighContrast: (on: boolean) => void;
};

const DisplayPrefsContext = createContext<DisplayPrefsValue | null>(null);

/**
 * Holds the display preferences (appearance, text size, high contrast) and
 * applies them to the document. Settings and the header quick-access sheet
 * both read and change them through this context.
 */
export function DisplayPrefsProvider({ children }: { children: ReactNode }) {
  // Server and first client render both start from the defaults, so the
  // markup matches during hydration; the device's saved values load in an
  // effect right after.
  const [loaded, setLoaded] = useState(false);
  const [fontScale, setFontScaleState] = useState<FontScaleKey>("1");
  const [contrastPref, setContrastPref] = useState<boolean | null>(null);
  const [systemMoreContrast, setSystemMoreContrast] = useState(false);
  const [colorScheme, setColorSchemeState] =
    useState<ColorSchemePreference>("system");

  useEffect(() => {
    setFontScaleState(readFontScale());
    setContrastPref(readHighContrastPreference());
    setSystemMoreContrast(systemPrefersMoreContrast());
    setColorSchemeState(readColorScheme());
    setLoaded(true);
  }, []);

  const highContrast = resolveHighContrast(contrastPref, systemMoreContrast);

  useEffect(() => {
    // Until the saved values load, leave the document as the head script
    // set it, so a saved dark theme does not flash light.
    if (!loaded) return;
    applyDisplayPrefsToDocument(fontScale, highContrast, colorScheme);
  }, [loaded, fontScale, highContrast, colorScheme]);

  useEffect(() => {
    if (!loaded || colorScheme !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () =>
      applyDisplayPrefsToDocument(fontScale, highContrast, "system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [loaded, colorScheme, fontScale, highContrast]);

  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(PREFERS_MORE_CONTRAST_QUERY);
    const onChange = () => setSystemMoreContrast(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const setColorScheme = useCallback((v: ColorSchemePreference) => {
    writeColorScheme(v);
    setColorSchemeState(v);
  }, []);
  const setFontScale = useCallback((v: FontScaleKey) => {
    writeFontScale(v);
    setFontScaleState(v);
  }, []);
  const setHighContrast = useCallback((on: boolean) => {
    writeHighContrast(on);
    setContrastPref(on);
  }, []);

  const value = useMemo(
    () => ({
      colorScheme,
      fontScale,
      highContrast,
      setColorScheme,
      setFontScale,
      setHighContrast,
    }),
    [
      colorScheme,
      fontScale,
      highContrast,
      setColorScheme,
      setFontScale,
      setHighContrast,
    ],
  );

  return (
    <DisplayPrefsContext.Provider value={value}>
      {children}
    </DisplayPrefsContext.Provider>
  );
}

export function useDisplayPrefs(): DisplayPrefsValue {
  const ctx = useContext(DisplayPrefsContext);
  if (!ctx) {
    throw new Error("useDisplayPrefs must be used inside DisplayPrefsProvider");
  }
  return ctx;
}
