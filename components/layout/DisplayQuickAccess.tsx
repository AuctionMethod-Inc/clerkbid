"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { SunMoon, X } from "lucide-react";
import { DisplayPrefsControls } from "@/components/settings/DisplayPrefsControls";

/**
 * Header button that opens the display controls in a sheet, so a clerk can
 * switch to high contrast without going to Settings. The sheet is portaled
 * to <body> because the sidebar uses a transform, which would otherwise trap
 * its fixed positioning.
 */
export function DisplayQuickAccess() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Display options"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-navy outline-none ring-navy/20 transition hover:bg-navy/5 focus-visible:ring-2 dark:text-slate-200 dark:ring-slate-500/40 dark:hover:bg-slate-800"
      >
        <SunMoon className="h-4 w-4" aria-hidden />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <>
              <button
                type="button"
                aria-label="Close display options"
                className="fixed inset-0 z-50 cursor-default bg-ink/30"
                onClick={() => setOpen(false)}
              />
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border border-navy/10 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900 md:inset-x-auto md:bottom-auto md:left-64 md:top-4 md:w-[26rem] md:rounded-2xl"
              >
                <div className="mb-4 flex items-center justify-between gap-2">
                  <h2
                    id={titleId}
                    className="text-base font-semibold text-navy dark:text-slate-100"
                  >
                    Display
                  </h2>
                  <button
                    type="button"
                    aria-label="Close"
                    autoFocus
                    onClick={() => {
                      setOpen(false);
                      buttonRef.current?.focus();
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-navy/5 hover:text-ink dark:hover:bg-slate-800 dark:hover:text-slate-100"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                </div>
                <DisplayPrefsControls />
                <p className="mt-5 text-xs text-muted dark:text-slate-400">
                  Also in{" "}
                  <Link
                    href="/settings/"
                    onClick={() => setOpen(false)}
                    className="font-medium text-navy underline dark:text-slate-200"
                  >
                    Settings
                  </Link>
                  .
                </p>
              </div>
            </>,
            document.body,
          )
        : null}
    </>
  );
}
