"use client";

import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { Button } from "@/components/ui/Button";

function formatRelative(d: Date | null): string {
  if (d == null) return "—";
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Compact cloud sync status in the header; hover or focus for details. */
export function SyncStatusIndicator({
  tooltipAlign = "right",
}: {
  /** Which edge of the icon the details panel lines up with. */
  tooltipAlign?: "left" | "right";
} = {}) {
  const {
    online,
    syncPhase,
    lastPushAt,
    lastPullAt,
    lastSyncError,
    cloudSyncAvailable,
    remoteCloudSnapshotAt,
    dismissRemoteCloudSnapshotHint,
    restoreFromCloud,
    pushNow,
  } = useCloudSync();

  const busy = syncPhase === "pushing" || syncPhase === "pulling";
  const newerRemote =
    remoteCloudSnapshotAt != null && remoteCloudSnapshotAt.length > 0;
  const conflictServerTimeLabel =
    newerRemote && remoteCloudSnapshotAt !== "unknown"
      ? (() => {
          const d = new Date(remoteCloudSnapshotAt);
          return Number.isNaN(d.getTime()) ? null : d.toLocaleString();
        })()
      : null;

  let dotClass =
    "bg-emerald-500 shadow-[0_0_0_1px_rgba(255,255,255,0.4)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.35)]";
  let label = "Cloud sync: connected";

  if (!cloudSyncAvailable) {
    dotClass = "bg-amber-500";
    label = "Cloud backup not available on this server";
  } else if (!online) {
    dotClass = "bg-rose-500";
    label = "Cloud sync paused — you are offline";
  } else if (busy) {
    dotClass = "animate-pulse bg-sky-500";
    label = "Cloud sync in progress";
  } else if (lastSyncError) {
    dotClass = "bg-red-500";
    label = "Cloud sync error";
  }

  if (newerRemote && cloudSyncAvailable && online) {
    label +=
      ". Auto-merge could not resolve a sync conflict — open tooltip for actions.";
  }

  const tooltipId = "cloud-sync-status-tooltip";

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        className="flex h-8 min-w-8 items-center justify-center gap-0.5 rounded-md border border-transparent px-1 text-navy outline-none ring-navy/20 transition hover:bg-navy/5 focus-visible:ring-2 dark:text-slate-200 dark:hover:bg-slate-800 dark:ring-slate-500/40"
        aria-describedby={tooltipId}
        aria-label={label}
      >
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${dotClass}`}
          aria-hidden
        />
        {newerRemote ? (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-500 shadow-[0_0_0_1px_rgba(255,255,255,0.35)] dark:shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
            aria-hidden
          />
        ) : null}
      </button>
      <div
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-auto invisible absolute ${tooltipAlign === "left" ? "left-0" : "right-0"} top-full z-50 mt-1 w-max max-w-[min(22rem,calc(100vw-2rem))] translate-y-0 rounded-md border border-navy/15 bg-white p-3 text-left text-xs text-ink opacity-0 shadow-lg transition-opacity duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100`}
      >
        {newerRemote && cloudSyncAvailable ? (
          <div className="mb-3 border-b border-navy/10 pb-3 dark:border-slate-600">
            <p className="font-medium text-amber-900 dark:text-amber-200">
              Sync conflict
            </p>
            <p className="mt-1 text-muted dark:text-slate-400">
              Auto-merge could not fully resolve a conflict with the server
              {conflictServerTimeLabel
                ? ` (server copy from ${conflictServerTimeLabel})`
                : ""}
              . Restore to use the cloud copy, or push to overwrite it with
              this device.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                variant="primary"
                className="px-3 py-1.5 text-xs"
                disabled={!online}
                onClick={() => void restoreFromCloud()}
              >
                Restore
              </Button>
              <Button
                variant="secondary"
                className="px-3 py-1.5 text-xs"
                disabled={!online}
                onClick={() => void pushNow({ force: true })}
              >
                Push this device
              </Button>
              <Button
                variant="ghost"
                className="px-3 py-1.5 text-xs"
                onClick={dismissRemoteCloudSnapshotHint}
              >
                Dismiss
              </Button>
            </div>
            {!online ? (
              <p className="mt-2 text-rose-800 dark:text-rose-200">
                Reconnect to restore or push.
              </p>
            ) : null}
          </div>
        ) : null}
        {!cloudSyncAvailable ? (
          <p className="text-amber-900 dark:text-amber-200">
            Cloud backup is not available on this server (database not
            configured). Your data stays on this device only.
          </p>
        ) : !online ? (
          <p className="text-rose-900 dark:text-rose-200">
            You&apos;re offline — changes stay on this device only; cloud sync is
            paused. If teammates are online, their devices won&apos;t see your
            edits until you reconnect and sync. Two devices both offline can
            diverge; use Restore from cloud or Overwrite in Settings after
            reconnect if needed.
          </p>
        ) : (
          <div className="space-y-2 text-muted dark:text-slate-400">
            <p className="font-medium text-navy dark:text-slate-200">
              Cloud sync
              {busy ? (
                <span className="font-normal"> — Syncing with cloud…</span>
              ) : (
                <span className="font-normal"> — On · connected</span>
              )}
            </p>
            <p>
              Last backup to account:{" "}
              {lastPushAt == null ? (
                <span className="text-amber-800 dark:text-amber-200">
                  not from this device yet
                </span>
              ) : (
                formatRelative(lastPushAt)
              )}
            </p>
            <p>
              Checked cloud for other devices: {formatRelative(lastPullAt)}
            </p>
            {lastSyncError ? (
              <p className="text-danger dark:text-red-400">{lastSyncError}</p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
