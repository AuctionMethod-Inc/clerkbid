"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EventSettingsForm } from "@/components/settings/EventSettingsForm";
import { GlobalInvoiceBrandingCard } from "@/components/settings/GlobalInvoiceBrandingCard";
import { OrganizationTeamCard } from "@/components/settings/OrganizationTeamCard";
import { ClearEventDataDialog } from "@/components/settings/ClearEventDataDialog";
import { DisplayPrefsControls } from "@/components/settings/DisplayPrefsControls";
import { useCurrentEvent } from "@/lib/hooks/useCurrentEvent";
import { usePwaInstall } from "@/lib/hooks/usePwaInstall";
import { useToast } from "@/components/providers/ToastProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import type { AuctionDB, SyncConflictRow } from "@/lib/db";
import { isSyncOpsEnabled } from "@/lib/sync/syncOpsFlag";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { ensureSettingsRow } from "@/lib/settings";
import {
  buildEventExport,
  buildFullDatabaseExport,
  downloadJson,
  importEventFromPayload,
  importFullDatabaseEvents,
  parseEventExportPayload,
  parseFullDatabaseExport,
} from "@/lib/services/dataPorter";
import { clearEventDataKeepShell } from "@/lib/services/eventService";
import { APP_VERSION } from "@/lib/utils/constants";
import { formatBytes } from "@/lib/utils/formatBytes";
import { formatDateTime } from "@/lib/utils/formatDate";
import { liveQueryGuard } from "@/lib/dexie/liveQueryGuard";

async function touchBackupDate(db: AuctionDB) {
  await ensureSettingsRow(db);
  await db.settings.update(1, { lastBackupDate: new Date() });
}

export default function SettingsPage() {
  const { db, ready: dbReady } = useUserDb();
  const { currentEvent, currentEventId, switchEvent, refresh } =
    useCurrentEvent();
  const { showToast } = useToast();
  const { pushNow, restoreFromCloud, lastPushAt } = useCloudSync();
  const { isStandalone, canInstall, promptInstall } = usePwaInstall();
  const [clearOpen, setClearOpen] = useState(false);
  const [monthlyBackupEmail, setMonthlyBackupEmail] = useState(false);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number }>(
    {}
  );

  const fileEventRef = useRef<HTMLInputElement>(null);
  const fileFullRef = useRef<HTMLInputElement>(null);

  const settingsRow = useLiveQuery(
    async () =>
      liveQueryGuard("settings.page.settings", async () => {
        if (!dbReady || !db) return undefined;
        await ensureSettingsRow(db);
        return db.settings.get(1);
      }, undefined),
    [dbReady, db]
  );

  const syncConflicts = useLiveQuery(
    async () =>
      liveQueryGuard(
        "settings.page.syncConflicts",
        async () => {
          if (!dbReady || !db || !isSyncOpsEnabled()) return [];
          const rows = await db.syncConflicts
            .filter((c) => c.dismissedAt == null)
            .toArray();
          rows.sort(
            (a, b) =>
              (b.createdAt?.getTime?.() ?? 0) - (a.createdAt?.getTime?.() ?? 0)
          );
          return rows;
        },
        []
      ),
    [dbReady, db]
  );

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
      return;
    }
    void navigator.storage.estimate().then((e) => {
      setStorage({ usage: e.usage, quota: e.quota });
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/sync/preferences/", { credentials: "include" });
        if (!res.ok) return;
        const data = (await res.json()) as { monthlyBackupEmail?: boolean };
        if (!cancelled) {
          setMonthlyBackupEmail(data.monthlyBackupEmail === true);
          setPrefsLoaded(true);
        }
      } catch {
        if (!cancelled) setPrefsLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function slug(name: string) {
    return name.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 40) || "event";
  }

  async function exportCurrentEvent() {
    if (currentEventId == null || !db) return;
    try {
      const data = await buildEventExport(db, currentEventId, APP_VERSION);
      downloadJson(
        `clerkbid-event-${slug(currentEvent?.name ?? "export")}.json`,
        data
      );
      await touchBackupDate(db);
      refresh();
      showToast({ kind: "success", message: "Event exported." });
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Export failed.",
      });
    }
  }

  async function exportAllEvents() {
    if (!db) return;
    try {
      const data = await buildFullDatabaseExport(db, APP_VERSION);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadJson(`clerkbid-all-events-${stamp}.json`, data);
      await touchBackupDate(db);
      refresh();
      showToast({ kind: "success", message: "Full database exported." });
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Export failed.",
      });
    }
  }

  async function onImportEventFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !db) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text) as unknown;
      const payload = parseEventExportPayload(raw);
      const summary = await importEventFromPayload(db, payload);
      await switchEvent(summary.eventId);
      refresh();
      showToast({
        kind: "success",
        message: `Imported event: ${summary.bidders} bidders, ${summary.consignors} consignors, ${summary.lots} lots.`,
      });
    } catch (err) {
      showToast({
        kind: "error",
        message: err instanceof Error ? err.message : "Import failed.",
      });
    }
  }

  async function onImportFullFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !db) return;
    try {
      const text = await file.text();
      const raw = JSON.parse(text) as unknown;
      const data = parseFullDatabaseExport(raw);
      const { imported, failures } = await importFullDatabaseEvents(db, data);
      refresh();
      const msg =
        failures.length === 0
          ? `Imported ${imported} event(s).`
          : `Imported ${imported} event(s). ${failures.length} failed — check messages.`;
      showToast({
        kind: failures.length ? "error" : "success",
        message: msg,
      });
    } catch (err) {
      showToast({
        kind: "error",
        message: err instanceof Error ? err.message : "Import failed.",
      });
    }
  }

  async function handleClearConfirmed() {
    if (currentEventId == null || !db) return;
    await clearEventDataKeepShell(db, currentEventId);
    setClearOpen(false);
    refresh();
    showToast({
      kind: "success",
      message: "All clerking data cleared for this event.",
    });
  }

  return (
    <div className="space-y-10">
      <Header
        title="Settings"
        description="Event details, backups, and app information."
      />

      <GlobalInvoiceBrandingCard
        onSaved={() => {
          refresh();
          showToast({ kind: "success", message: "Invoice defaults saved." });
        }}
      />

      <OrganizationTeamCard />

      {currentEvent && currentEventId != null ? (
        <EventSettingsForm
          event={currentEvent}
          onSaved={() => {
            refresh();
            showToast({ kind: "success", message: "Event settings saved." });
          }}
        />
      ) : (
        <Card>
          <p className="text-sm text-muted">
            Select an event in the sidebar to edit organization name, tax rate,
            currency, and per-event invoice overrides.
          </p>
        </Card>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-navy dark:text-slate-100">Display</h2>
        <Card>
          <p className="mb-4 text-sm text-muted">
            Saved on this device. Also available from the sun and moon icon
            next to the ClerkBid logo.
          </p>
          <DisplayPrefsControls />
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-navy dark:text-slate-100">Cloud backup</h2>
        <Card className="space-y-4">
          <p className="text-sm text-muted">
            While you&apos;re signed in, we keep a cloud copy of each event for
            your <strong className="font-medium text-navy dark:text-slate-200">whole organization</strong>{" "}
            (everyone with your vendor account sees the same backups). Use
            &quot;Sync now&quot; after important changes, especially if multiple
            people work the same sale.
          </p>
          {currentEvent ? (
            <p className="text-xs text-muted">
              Backup reference (for support):{" "}
              <span className="font-mono text-ink">{currentEvent.syncId}</span>
            </p>
          ) : null}
          <p className="text-xs text-muted">
            {currentEvent?.lastCloudPushAt
              ? `Last cloud save: ${formatDateTime(currentEvent.lastCloudPushAt)}`
              : lastPushAt
                ? `Last cloud save: ${formatDateTime(lastPushAt)}`
                : "No cloud save recorded for this event yet."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={currentEventId == null}
              onClick={() => void pushNow()}
            >
              Sync now
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={currentEventId == null}
              onClick={() => {
                if (
                  !window.confirm(
                    "Replace this event’s data on this device with the latest cloud backup? Unsaved local changes since your last cloud save will be lost."
                  )
                ) {
                  return;
                }
                void restoreFromCloud();
              }}
            >
              Restore from cloud
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={currentEventId == null}
              onClick={() => {
                if (
                  !window.confirm(
                    "Replace the cloud backup with what’s on this device? Use this if the cloud copy is wrong or out of date."
                  )
                ) {
                  return;
                }
                void pushNow({ force: true });
              }}
            >
              Overwrite cloud copy
            </Button>
          </div>
          <p className="text-xs text-muted">
            If sync always fails, your site administrator may need to finish
            backup setup. You can still use &quot;Export&quot; below to download
            a file you keep yourself.
          </p>
          <div className="border-t border-navy/10 pt-4">
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-navy/30"
                checked={monthlyBackupEmail}
                disabled={!prefsLoaded}
                onChange={async (e) => {
                  const checked = e.target.checked;
                  setMonthlyBackupEmail(checked);
                  try {
                    const res = await fetch("/api/sync/preferences/", {
                      method: "PATCH",
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ monthlyBackupEmail: checked }),
                    });
                    if (!res.ok) {
                      setMonthlyBackupEmail(!checked);
                      showToast({
                        kind: "error",
                        message: "Could not save email backup preference.",
                      });
                      return;
                    }
                    showToast({
                      kind: "success",
                      message: checked
                        ? "Monthly email backup enabled."
                        : "Monthly email backup disabled.",
                    });
                  } catch {
                    setMonthlyBackupEmail(!checked);
                    showToast({
                      kind: "error",
                      message: "Could not save preference.",
                    });
                  }
                }}
              />
              <span>
                <span className="font-medium text-navy dark:text-slate-100">
                  Email me a monthly JSON backup
                </span>
                <span className="mt-0.5 block text-xs text-muted">
                  On the first day of each month we&apos;ll email a backup file
                  of your cloud-saved events to the address you use to sign in.
                  Turn this off anytime. This only runs if you&apos;ve been
                  using cloud sync successfully.
                </span>
              </span>
            </label>
          </div>
        </Card>
      </section>

      {isSyncOpsEnabled() ? (
        <section>
          <h2 className="mb-3 text-lg font-semibold text-navy dark:text-slate-100">
            Operation sync — needs review
          </h2>
          <Card className="space-y-3">
            <p className="text-sm text-muted">
              When two devices edit the same sale or invoice in conflicting
              ways, we record it here. Dismiss after you&apos;ve fixed the data
              on this device (or restored from cloud).
            </p>
            {!dbReady || !db ? (
              <p className="text-sm text-muted">Loading…</p>
            ) : (syncConflicts?.length ?? 0) === 0 ? (
              <p className="text-sm text-muted">No open conflicts.</p>
            ) : (
              <ul className="space-y-3">
                {(syncConflicts as SyncConflictRow[]).map((c) => (
                  <li
                    key={c.id ?? `${c.eventSyncId}-${c.createdAt}`}
                    className="rounded-lg border border-navy/10 p-3 text-sm dark:border-slate-600"
                  >
                    <p className="font-mono text-xs text-muted">
                      {c.eventSyncId} · {c.opType}
                    </p>
                    <p className="mt-1 text-ink dark:text-slate-100">
                      {c.detail}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {c.createdAt
                        ? formatDateTime(c.createdAt)
                        : ""}
                    </p>
                    <Button
                      type="button"
                      variant="secondary"
                      className="mt-2"
                      disabled={c.id == null}
                      onClick={() => {
                        if (c.id == null || !db) return;
                        void db.syncConflicts.update(c.id, {
                          dismissedAt: new Date(),
                        });
                        showToast({
                          kind: "success",
                          message: "Conflict dismissed.",
                        });
                      }}
                    >
                      Dismiss
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      ) : null}

      <section>
        <h2 className="mb-3 text-lg font-semibold text-navy dark:text-slate-100">Data management</h2>
        <Card className="space-y-4">
          <input
            ref={fileEventRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-hidden
            onChange={onImportEventFile}
          />
          <input
            ref={fileFullRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-hidden
            onChange={onImportFullFile}
          />
          <p className="text-sm text-muted">
            Your auction data stays on this device for your signed-in account.
            Cloud backup (above) and file export give you extra copies and a
            way to move data to another computer.
            {settingsRow?.lastBackupDate ? (
              <span className="mt-1 block text-xs">
                Last backup recorded:{" "}
                {formatDateTime(settingsRow.lastBackupDate)}
              </span>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={currentEventId == null}
              onClick={() => void exportCurrentEvent()}
            >
              Export current event
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void exportAllEvents()}
            >
              Export all events
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => fileEventRef.current?.click()}
            >
              Import event (JSON)
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => fileFullRef.current?.click()}
            >
              Import full backup
            </Button>
          </div>
          <p className="text-xs text-muted">
            <strong>Import event</strong> adds one new event from a single-event
            file you exported from ClerkBid. <strong>Import full backup</strong>{" "}
            adds every event from a &quot;Export all events&quot; file—each
            becomes a separate new event in your list.
          </p>
          <div className="border-t border-navy/10 pt-4">
            <Button
              type="button"
              variant="danger"
              disabled={currentEventId == null}
              onClick={() => setClearOpen(true)}
            >
              Clear current event data…
            </Button>
            <p className="mt-2 text-xs text-muted">
              Removes bidders, lots, sales, and invoices for the selected event
              only. Requires three confirmations. The event shell remains.
            </p>
          </div>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-navy dark:text-slate-100">About</h2>
        <Card className="space-y-3 text-sm">
          <p>
            <span className="font-semibold text-navy dark:text-slate-100">
              ClerkBid
            </span>{" "}
            — auction clerking for live sales. Data lives on this device; if
            you lose connectivity after you&apos;re already signed in, you can
            often keep clerking until the network returns. You still need the
            internet to sign in, register, and use cloud backup—don&apos;t plan
            on using ClerkBid entirely offline from a cold start. You can
            install it like an app for quick launch; optional cloud backup is
            available when you&apos;re signed in.
          </p>
          <p className="rounded-lg border border-gold/30 bg-amber-50/60 px-3 py-2.5 text-muted dark:border-amber-900/40 dark:bg-amber-950/25 dark:text-slate-300">
            <span className="font-medium text-navy dark:text-slate-100">
              Your input shapes the product.
            </span>{" "}
            Use{" "}
            <Link
              href="/feedback/"
              className="font-medium text-navy underline underline-offset-2 dark:text-sky-300"
            >
              Feedback &amp; requests
            </Link>{" "}
            for bugs, ideas, and changes you need—we read everything.
          </p>
          <p className="text-muted">
            Version <span className="font-mono text-ink">{APP_VERSION}</span>
          </p>
          <p className="text-muted">
            <Link
              href="/user-agreement/"
              className="font-medium text-navy underline underline-offset-2 dark:text-sky-300"
            >
              User agreement
            </Link>
            <span className="mx-2 text-navy/25 dark:text-slate-600">·</span>
            <Link
              href="/privacy-policy/"
              className="font-medium text-navy underline underline-offset-2 dark:text-sky-300"
            >
              Privacy policy
            </Link>
            <span className="mx-2 text-navy/25 dark:text-slate-600">·</span>
            <Link
              href="/feedback/"
              className="font-medium text-navy underline underline-offset-2 dark:text-sky-300"
            >
              Feedback form
            </Link>
          </p>
          <p className="text-muted">
            Storage (approx.): {formatBytes(storage.usage)} used
            {storage.quota != null
              ? ` of ${formatBytes(storage.quota)} available`
              : ""}
            {storage.usage == null && storage.quota == null
              ? " — estimate not available in this browser."
              : ""}
          </p>
          <div className="border-t border-navy/10 pt-3">
            {isStandalone ? (
              <p className="text-green-700">Running as installed app.</p>
            ) : canInstall ? (
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-muted">
                  Install ClerkBid for quick launch from your home screen or
                  dock (same app; easier to reopen if the connection drops mid
                  session).
                </p>
                <Button type="button" onClick={() => void promptInstall()}>
                  Install app
                </Button>
              </div>
            ) : (
              <p className="text-muted">
                Install: use your browser menu (“Install app” / “Add to Home
                Screen”) when offered. The install prompt appears when the site
                meets PWA criteria.
              </p>
            )}
          </div>
        </Card>
      </section>

      <ClearEventDataDialog
        open={clearOpen}
        eventName={currentEvent?.name ?? "this event"}
        onClose={() => setClearOpen(false)}
        onConfirm={() => void handleClearConfirmed()}
      />
    </div>
  );
}
