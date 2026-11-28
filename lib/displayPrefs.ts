const FONT_KEY = "clerkbid:fontScale";
const CONTRAST_KEY = "clerkbid:highContrast";
export const COLOR_SCHEME_STORAGE_KEY = "clerkbid:colorScheme";

export type FontScaleKey = "1" | "1.15" | "1.3";

export type ColorSchemePreference = "light" | "dark" | "system";

export const DEFAULT_COLOR_SCHEME: ColorSchemePreference = "system";

/** Inline head script: must stay in sync with readColorScheme / isEffectiveDark. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var k=${JSON.stringify(COLOR_SCHEME_STORAGE_KEY)};var v=localStorage.getItem(k)||"system";var d=v==="dark"||(v==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

export function readFontScale(): FontScaleKey {
  if (typeof window === "undefined") return "1";
  try {
    const v = localStorage.getItem(FONT_KEY);
    if (v === "1.15" || v === "1.3") return v;
  } catch {
    /* ignore */
  }
  return "1";
}

export function writeFontScale(v: FontScaleKey): void {
  try {
    localStorage.setItem(FONT_KEY, v);
  } catch {
    /* ignore */
  }
}

export const FONT_SCALE_STEPS: readonly FontScaleKey[] = ["1", "1.15", "1.3"];

export const FONT_SCALE_LABELS: Record<FontScaleKey, string> = {
  "1": "Default",
  "1.15": "Large",
  "1.3": "Larger",
};

export const COLOR_SCHEME_LABELS: Record<ColorSchemePreference, string> = {
  light: "Light",
  dark: "Dark",
  system: "Auto",
};

export const PREFERS_MORE_CONTRAST_QUERY = "(prefers-contrast: more)";

/**
 * The user's explicit high contrast choice: true or false once they have set
 * it, null when they never did (the device setting then decides).
 */
export function readHighContrastPreference(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(CONTRAST_KEY);
    if (v === "1") return true;
    if (v === "0") return false;
  } catch {
    /* ignore */
  }
  return null;
}

export function systemPrefersMoreContrast(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia(PREFERS_MORE_CONTRAST_QUERY).matches;
  } catch {
    return false;
  }
}

/** An explicit choice wins; otherwise follow the device's contrast setting. */
export function resolveHighContrast(
  preference: boolean | null,
  systemPrefersMore: boolean
): boolean {
  return preference ?? systemPrefersMore;
}

export function readHighContrast(): boolean {
  return resolveHighContrast(
    readHighContrastPreference(),
    systemPrefersMoreContrast()
  );
}

export function writeHighContrast(on: boolean): void {
  try {
    localStorage.setItem(CONTRAST_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function readColorScheme(): ColorSchemePreference {
  if (typeof window === "undefined") return DEFAULT_COLOR_SCHEME;
  try {
    const v = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_COLOR_SCHEME;
}

export function writeColorScheme(p: ColorSchemePreference): void {
  try {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, p);
  } catch {
    /* ignore */
  }
}

export function isEffectiveDark(pref: ColorSchemePreference): boolean {
  if (typeof window === "undefined") return false;
  if (pref === "dark") return true;
  if (pref === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function applyColorSchemeClass(pref: ColorSchemePreference): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", isEffectiveDark(pref));
}

export function applyDisplayPrefsToDocument(
  font: FontScaleKey,
  highContrast: boolean,
  colorScheme: ColorSchemePreference
): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.fontScale = font;
  document.documentElement.dataset.highContrast = highContrast ? "true" : "false";
  applyColorSchemeClass(colorScheme);
}
