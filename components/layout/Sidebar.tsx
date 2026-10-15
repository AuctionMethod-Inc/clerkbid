"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  Package,
  ClipboardList,
  Gavel,
  FileText,
  BarChart3,
  CircleHelp,
  Inbox,
  MessageSquare,
  Settings,
  Shield,
  LogOut,
  X,
  BookUser,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { isSuperAdminUserIdAndEmail } from "@/lib/auth/superAdmin";
import { clearOfflineSessionSnapshot } from "@/lib/auth/offlineSession";
import { closeAndClearAuctionDbCache } from "@/lib/db";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { EventSwitcher } from "./EventSwitcher";

const nav = [
  { href: "/dashboard/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/events/", label: "Events", icon: CalendarDays },
  { href: "/directory/", label: "Directory", icon: BookUser },
  { href: "/bidders/", label: "Bidders", icon: Users },
  { href: "/consignors/", label: "Consignors", icon: Package },
  { href: "/lots/", label: "Lots", icon: ClipboardList },
  { href: "/clerking/", label: "Clerking", icon: Gavel },
  { href: "/invoices/", label: "Invoices", icon: FileText },
  { href: "/reports/", label: "Reports", icon: BarChart3 },
  { href: "/help/", label: "Help", icon: CircleHelp },
  { href: "/announcements/", label: "Message center", icon: Inbox },
  { href: "/feedback/", label: "Feedback", icon: MessageSquare },
  { href: "/settings/", label: "Settings", icon: Settings },
];

type SidebarProps = {
  id?: string;
  /** When false on viewports below `md`, sidebar is off-canvas. Desktop ignores this. */
  mobileOpen?: boolean;
  /** Called after navigation on mobile and from the close control. */
  onClose?: () => void;
};

export function Sidebar({
  id = "app-sidebar",
  mobileOpen = false,
  onClose,
}: SidebarProps) {
  const pathname = usePathname();
  const { data: session, status } = useSession();
  const { ensureCloudBackupBeforeSignOut } = useCloudSync();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    onClose?.();
  }, [pathname, onClose]);

  const showAdminLink =
    status === "authenticated" &&
    session?.user &&
    isSuperAdminUserIdAndEmail(session.user.id, session.user.email) &&
    !session.impersonatedByUserId;

  const adminNav = showAdminLink
    ? [{ href: "/admin/", label: "Admin", icon: Shield }]
    : [];

  const mainNav = [
    ...nav.slice(0, -1),
    ...adminNav,
    nav[nav.length - 1]!,
  ];

  const handleNavClick = () => {
    onClose?.();
  };

  return (
    <aside
      id={id}
      className={`fixed inset-y-0 left-0 z-40 flex h-full w-[min(100vw-3rem,15rem)] max-w-[15rem] shrink-0 flex-col border-r border-navy/10 bg-surface transition-transform duration-200 ease-out dark:border-slate-700 dark:bg-slate-900 md:relative md:z-0 md:h-full md:w-60 md:max-w-none md:translate-x-0 ${
        mobileOpen
          ? "translate-x-0"
          : "-translate-x-full pointer-events-none md:pointer-events-auto"
      }`}
    >
      <div className="border-b border-navy/10 p-4 dark:border-slate-700">
        <div className="flex items-start justify-between gap-2">
          <Link
            href="/dashboard/"
            className="block min-w-0 flex-1"
            onClick={handleNavClick}
          >
            <span className="text-lg font-bold tracking-tight text-navy dark:text-slate-100">
              Clerk<span className="text-gold">Bid</span>
            </span>
            <span className="mt-0.5 block text-xs text-muted dark:text-slate-400">
              Auction clerking
            </span>
          </Link>
          <button
            type="button"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-white/80 hover:text-ink dark:hover:bg-slate-800 dark:hover:text-slate-100 md:hidden"
            aria-label="Close menu"
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        <div className="mt-4">
          <EventSwitcher />
        </div>
      </div>
      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="Main">
        {mainNav.map(({ href, label, icon: Icon }) => {
          const p = (pathname ?? "/").replace(/\/$/, "") || "/";
          const h = href.replace(/\/$/, "") || "/";
          const active = p === h || p.startsWith(`${h}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={handleNavClick}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                active
                  ? "bg-white text-navy shadow-sm ring-1 ring-navy/10 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600"
                  : "text-muted hover:bg-white/60 hover:text-ink dark:hover:bg-slate-800/60 dark:hover:text-slate-100"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-navy/10 p-3 dark:border-slate-700">
        <button
          type="button"
          disabled={signingOut}
          aria-busy={signingOut}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-muted transition hover:bg-white/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-slate-800/60 dark:hover:text-slate-100"
          onClick={() => {
            void (async () => {
              if (signingOut) return;
              setSigningOut(true);
              try {
                const ok = await ensureCloudBackupBeforeSignOut();
                if (!ok) return;
                clearOfflineSessionSnapshot();
                closeAndClearAuctionDbCache();
                await signOut({ callbackUrl: "/" });
              } finally {
                setSigningOut(false);
              }
            })();
          }}
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden />
          {signingOut ? "Saving to cloud…" : "Sign out"}
        </button>
      </div>
    </aside>
  );
}
