"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Menu } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { PoweredByFooter } from "./PoweredByFooter";
import { HeaderStatusIcons } from "./HeaderStatusIcons";
import { DisplayPrefsProvider } from "@/components/providers/DisplayPrefsProvider";

export function AppShell({
  children,
  topBanner,
}: {
  children: ReactNode;
  topBanner?: ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSidebarOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  return (
    <DisplayPrefsProvider>
      <div className="flex min-h-screen">
        {sidebarOpen ? (
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-30 bg-ink/40 md:hidden"
            onClick={closeSidebar}
          />
        ) : null}
        <Sidebar
          id="app-sidebar"
          mobileOpen={sidebarOpen}
          onClose={closeSidebar}
        />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <div className="sticky top-0 z-20">
            <div className="flex items-center gap-2 border-b border-navy/10 bg-white px-4 py-2 dark:border-slate-700 dark:bg-slate-900 md:hidden">
              <button
                ref={menuButtonRef}
                type="button"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-navy/15 text-navy transition hover:bg-navy/5 dark:border-slate-600 dark:text-slate-100 dark:hover:bg-slate-800"
                aria-expanded={sidebarOpen}
                aria-controls="app-sidebar"
                aria-label={
                  sidebarOpen ? "Close navigation menu" : "Open navigation menu"
                }
                onClick={() => {
                  setSidebarOpen((o) => !o);
                }}
              >
                <Menu className="h-5 w-5" aria-hidden />
              </button>
              <span className="text-sm font-semibold text-navy dark:text-slate-100">
                ClerkBid
              </span>
              <div className="ml-auto">
                <HeaderStatusIcons />
              </div>
            </div>
          </div>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-4 sm:p-6 md:p-8 lg:p-10">
            {topBanner ? (
              <div className="mx-auto mb-4 w-full min-w-0 max-w-6xl">
                {topBanner}
              </div>
            ) : null}
            <div className="mx-auto w-full min-w-0 max-w-6xl">{children}</div>
          </main>
          <PoweredByFooter />
        </div>
      </div>
    </DisplayPrefsProvider>
  );
}
