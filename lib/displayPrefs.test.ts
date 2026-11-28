import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FONT_SCALE_STEPS,
  FONT_SCALE_LABELS,
  readColorScheme,
  readHighContrast,
  readHighContrastPreference,
  resolveHighContrast,
  writeHighContrast,
} from "./displayPrefs";

function installBrowser(opts: { prefersMoreContrast?: boolean } = {}) {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({
      matches:
        q === "(prefers-contrast: more)" ? !!opts.prefersMoreContrast : false,
    }),
  });
  return store;
}

describe("resolveHighContrast", () => {
  it("follows the device when the user never chose", () => {
    expect(resolveHighContrast(null, true)).toBe(true);
    expect(resolveHighContrast(null, false)).toBe(false);
  });

  it("lets an explicit choice override the device", () => {
    expect(resolveHighContrast(false, true)).toBe(false);
    expect(resolveHighContrast(true, false)).toBe(true);
  });
});

describe("high contrast storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is unset by default and follows the device's increase contrast setting", () => {
    installBrowser({ prefersMoreContrast: true });
    expect(readHighContrastPreference()).toBeNull();
    expect(readHighContrast()).toBe(true);
  });

  it("is off by default when the device has no contrast preference", () => {
    installBrowser();
    expect(readHighContrast()).toBe(false);
  });

  it("remembers an explicit off, even when the device asks for more contrast", () => {
    const store = installBrowser({ prefersMoreContrast: true });
    writeHighContrast(false);
    expect(store.get("clerkbid:highContrast")).toBe("0");
    expect(readHighContrastPreference()).toBe(false);
    expect(readHighContrast()).toBe(false);
  });

  it("remembers an explicit on", () => {
    installBrowser();
    writeHighContrast(true);
    expect(readHighContrastPreference()).toBe(true);
    expect(readHighContrast()).toBe(true);
  });
});

describe("defaults", () => {
  beforeEach(() => {
    installBrowser();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults appearance to Auto (follow the device)", () => {
    expect(readColorScheme()).toBe("system");
  });

  it("orders the text size slider Default, Large, Larger", () => {
    expect(FONT_SCALE_STEPS.map((s) => FONT_SCALE_LABELS[s])).toEqual([
      "Default",
      "Large",
      "Larger",
    ]);
  });
});
