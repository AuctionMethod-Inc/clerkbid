"use client";

import { useId } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { useDisplayPrefs } from "@/components/providers/DisplayPrefsProvider";
import {
  COLOR_SCHEME_LABELS,
  FONT_SCALE_LABELS,
  FONT_SCALE_STEPS,
  type ColorSchemePreference,
} from "@/lib/displayPrefs";

const APPEARANCE_OPTIONS: { value: ColorSchemePreference; icon: LucideIcon }[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

/** Appearance, text size and high contrast controls (Settings and the header sheet). */
export function DisplayPrefsControls() {
  const {
    colorScheme,
    fontScale,
    highContrast,
    setColorScheme,
    setFontScale,
    setHighContrast,
  } = useDisplayPrefs();
  const ids = useId();
  const sliderId = `${ids}-text-size`;
  const contrastId = `${ids}-contrast`;
  const fontIndex = Math.max(0, FONT_SCALE_STEPS.indexOf(fontScale));

  return (
    <div className="space-y-5">
      <div>
        <p
          id={`${ids}-appearance`}
          className="mb-2 text-sm font-medium text-navy dark:text-slate-200"
        >
          Appearance
        </p>
        <div
          role="radiogroup"
          aria-labelledby={`${ids}-appearance`}
          className="inline-flex rounded-lg border border-navy/15 bg-surface p-1 dark:border-slate-600 dark:bg-slate-800"
        >
          {APPEARANCE_OPTIONS.map(({ value, icon: Icon }) => {
            const selected = colorScheme === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setColorScheme(value)}
                className={`flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  selected
                    ? "bg-white text-navy shadow-sm ring-1 ring-navy/10 dark:bg-slate-700 dark:text-slate-100 dark:ring-slate-500"
                    : "text-muted hover:text-ink dark:text-slate-400 dark:hover:text-slate-100"
                }`}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {COLOR_SCHEME_LABELS[value]}
              </button>
            );
          })}
        </div>
        {colorScheme === "system" ? (
          <p className="mt-1.5 text-xs text-muted dark:text-slate-400">
            Auto follows this device&apos;s light or dark setting.
          </p>
        ) : null}
      </div>

      <div>
        <label
          htmlFor={sliderId}
          className="mb-2 block text-sm font-medium text-navy dark:text-slate-200"
        >
          Text size
        </label>
        <div className="flex items-center gap-4">
          <div className="w-full max-w-xs">
            <input
              id={sliderId}
              type="range"
              min={0}
              max={FONT_SCALE_STEPS.length - 1}
              step={1}
              value={fontIndex}
              aria-valuetext={FONT_SCALE_LABELS[fontScale]}
              onChange={(e) => {
                const next = FONT_SCALE_STEPS[Number(e.target.value)];
                if (next) setFontScale(next);
              }}
              className="w-full accent-navy dark:accent-slate-300"
            />
            <div
              className="mt-1 flex justify-between text-xs text-muted dark:text-slate-400"
              aria-hidden
            >
              {FONT_SCALE_STEPS.map((s) => (
                <span
                  key={s}
                  className={
                    s === fontScale ? "font-semibold text-navy dark:text-slate-100" : ""
                  }
                >
                  {FONT_SCALE_LABELS[s]}
                </span>
              ))}
            </div>
          </div>
          <span
            className="w-14 shrink-0 text-center text-2xl font-semibold leading-none text-navy dark:text-slate-100"
            aria-hidden
          >
            Aa
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div>
          <label
            htmlFor={contrastId}
            className="block text-sm font-medium text-navy dark:text-slate-200"
          >
            High contrast
          </label>
          <p className="text-xs text-muted dark:text-slate-400">
            Stronger text and borders, easier to read in sunlight.
          </p>
        </div>
        <button
          id={contrastId}
          type="button"
          role="switch"
          aria-checked={highContrast}
          onClick={() => setHighContrast(!highContrast)}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 dark:focus-visible:ring-slate-400 ${
            highContrast ? "bg-navy dark:bg-gold" : "bg-navy/20 dark:bg-slate-600"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
              highContrast ? "translate-x-6" : "translate-x-1"
            }`}
            aria-hidden
          />
        </button>
      </div>
    </div>
  );
}
