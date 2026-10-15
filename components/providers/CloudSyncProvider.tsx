"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import { ImpersonationBanner } from "@/components/admin/ImpersonationBanner";
import { AppShell } from "@/components/layout/AppShell";
import { useEventContext } from "@/components/providers/EventProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { useUserDb } from "@/components/providers/UserDbProvider";
import {
  fetchSyncList,
  pushAllLocalEvents,
  pushEventWithAutoMerge,
  pullCloudEventsMissingLocally,
  recordSuccessfulPush,
  refreshEventFromCloudIfServerNewer,
  refreshStaleLocalEventsFromList,
  restoreEventFromCloud,
  type PushAllSummary,
} from "@/lib/services/cloudSync";
import {
  pushAllPendingOps,
  runOperationLevelSync,
} from "@/lib/services/opSyncClient";
import { isAblyRealtimeSyncEnabled } from "@/lib/ably/ablySyncFlag";
import {
  eventSyncChannelName,
  GLOBAL_ANNOUNCE_CHANNEL,
} from "@/lib/ably/channels";
import { handleAblyAnnounceMessage } from "@/lib/ably/handleClientAnnounce";
import { isSyncOpsEnabled } from "@/lib/sync/syncOpsFlag";
import Ably from "ably";
import { ensureSettingsRow } from "@/lib/settings";
import { syncDirectoryWithCloud } from "@/lib/directory/sync";

/** Background pull uses this minimum gap between list fetches (see plan: ~30–60s). */
const PULL_LIST_THROTTLE_MS = 45_000;
/** Push all local events on this interval while online. Longer interval reduces
 *  conflict frequency; auto-merge handles the rest. */
const PUSH_ALL_INTERVAL_MS = 45_000;

type SyncPhase = "idle" | "pushing" | "pulling";

type PushResult = { ok: true } | { ok: false; message: string };

export type CloudSyncContextValue = {
  pushNow: (options?: { force?: boolean }) => Promise<boolean>;
  restoreFromCloud: () => Promise<boolean>;
  lastPushAt: Date | null;
  lastPullAt: Date | null;
  online: boolean;
  syncPhase: SyncPhase;
  lastSyncError: string | null;
  /** False when the server reports cloud sync tables missing (503). */
  cloudSyncAvailable: boolean;
  /** Debounced upload after local changes (events, bidders, sales, etc.). */
  scheduleCloudPush: () => void;
  /**
   * Uploads all local events to the cloud. Returns true when safe to sign out
   * (no events, or every event saved successfully).
   */
  ensureCloudBackupBeforeSignOut: () => Promise<boolean>;
  /**
   * Set only after the server rejected a snapshot push (409) for the current
   * event — not from background polling (avoids false alarms when teammates’
   * idle sync bumps `updated_at`). ISO time from the server, or `"unknown"`.
   */
  remoteCloudSnapshotAt: string | null;
  /** Hide the snapshot-conflict hint until the next 409 or event switch. */
  dismissRemoteCloudSnapshotHint: () => void;
};

const CloudSyncContext = createContext<CloudSyncContextValue | null>(null);

export function useCloudSync(): CloudSyncContextValue {
  const ctx = useContext(CloudSyncContext);
  if (!ctx) {
    throw new Error("useCloudSync must be used within CloudSyncProvider");
  }
  return ctx;
}

export function CloudSyncProvider({ children }: { children: ReactNode }) {
  const { status, data: session } = useSession();
  const { db, ready: dbReady } = useUserDb();
  const { currentEventId, currentEvent, refresh, switchEvent } =
    useEventContext();
  const { showToast } = useToast();

  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [remoteCloudSnapshotAt, setRemoteCloudSnapshotAt] = useState<
    string | null
  >(null);
  const [lastPushAt, setLastPushAt] = useState<Date | null>(null);
  const [lastPullAt, setLastPullAt] = useState<Date | null>(null);
  const [syncPhase, setSyncPhase] = useState<SyncPhase>("idle");
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [cloudSyncAvailable, setCloudSyncAvailable] = useState(true);

  /** Updated only after a successful `fetchSyncList` (so failed list calls can retry next cycle). */
  const lastSuccessfulPullListAtRef = useRef(0);
  const syncCycleLockRef = useRef(false);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const debouncedPushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const ablyPeerNudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const runPushAllSilentRef = useRef<() => Promise<void>>(async () => {});
  const runBackgroundSyncCycleRef = useRef<() => Promise<void>>(async () => {});
  /** Runs pending debounced snapshot push before any cloud pull/merge (avoids stale server re-adding deleted rows). */
  const flushDebouncedCloudPushBeforePullRef = useRef<() => Promise<void>>(
    async () => {}
  );
  const ablyDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  /** Ignore Ably snapshot refresh shortly after our own push (self-echo). */
  const lastOwnSnapshotPushAtRef = useRef(0);
  /** Latest selected event id (sync; avoids stale id after `await`). */
  const currentEventIdRef = useRef<number | null>(null);
  currentEventIdRef.current = currentEventId;
  /** Current event sync id for debounced Ably nudge (ref avoids stale closure). */
  const ablyEventSyncIdRef = useRef<string | null>(null);
  ablyEventSyncIdRef.current =
    currentEvent?.syncId?.trim() && currentEvent.syncId.trim().length > 0
      ? currentEvent.syncId.trim()
      : null;

  const dbRef = useRef(db);
  dbRef.current = db;
  const refreshForSyncRef = useRef(refresh);
  refreshForSyncRef.current = refresh;

  const updateSnapshotConflictHintFromPushSummary = useCallback(
    (summary: PushAllSummary) => {
      const liveId = currentEventIdRef.current;
      if (liveId == null) return;
      const conflict = summary.snapshotConflicts.find(
        (c) => c.eventId === liveId
      );
      if (conflict) {
        setRemoteCloudSnapshotAt(conflict.serverUpdatedAt ?? "unknown");
        return;
      }
      if (summary.snapshotPushedOkEventIds.includes(liveId)) {
        setRemoteCloudSnapshotAt(null);
      }
    },
    []
  );

  useEffect(() => {
    if (!dbReady || !db) return;
    void (async () => {
      await ensureSettingsRow(db);
      const s = await db.settings.get(1);
      if (s?.lastCloudPushAt) setLastPushAt(new Date(s.lastCloudPushAt));
      if (s?.lastCloudPullAt) setLastPullAt(new Date(s.lastCloudPullAt));
    })();
  }, [db, dbReady]);

  useEffect(() => {
    setRemoteCloudSnapshotAt(null);
  }, [currentEventId]);

  useEffect(() => {
    if (status !== "authenticated") {
      setRemoteCloudSnapshotAt(null);
    }
  }, [status]);

  const runPullAndMaybeSwitchEvent = useCallback(async () => {
    if (status !== "authenticated" || !db || !online) return;
    const now = Date.now();
    if (
      lastSuccessfulPullListAtRef.current > 0 &&
      now - lastSuccessfulPullListAtRef.current < PULL_LIST_THROTTLE_MS
    ) {
      return;
    }

    const list = await fetchSyncList();
    if (!list.ok) {
      if (list.status === 503) setCloudSyncAvailable(false);
      return;
    }
    setCloudSyncAvailable(true);
    lastSuccessfulPullListAtRef.current = Date.now();

    setSyncPhase("pulling");
    try {
      const r = await pullCloudEventsMissingLocally(db, list.events);
      const stale = await refreshStaleLocalEventsFromList(db, list.events);
      setLastPullAt(new Date());
      if (r.imported > 0 || stale.refreshed > 0 || list.events.length > 0) {
        refresh();
      }
      if (r.imported > 0) {
        await ensureSettingsRow(db);
        const settings = await db.settings.get(1);
        if (settings?.currentEventId == null) {
          const all = await db.events.toArray();
          all.sort(
            (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
          );
          const newest = all[0];
          if (newest?.id != null) await switchEvent(newest.id);
        }
      }
      if (r.fetchFailures > 0 && r.imported === 0) {
        setLastSyncError("Some cloud events could not be downloaded.");
      }
    } catch {
      setLastSyncError("Could not merge events from cloud.");
    } finally {
      setSyncPhase("idle");
    }
  }, [status, db, online, refresh, switchEvent]);

  const runPushAllSilent = useCallback(async () => {
    if (status !== "authenticated" || !db || !online) return;
    const count = await db.events.count();
    if (count === 0) return;

    setSyncPhase("pushing");
    try {
      if (isSyncOpsEnabled()) {
        await pushAllPendingOps(db);
      }
      const summary = await pushAllLocalEvents(db);
      if (summary.serverUnavailable) setCloudSyncAvailable(false);
      if (summary.lastUpdatedAt) {
        lastOwnSnapshotPushAtRef.current = Date.now();
        setLastPushAt(new Date(summary.lastUpdatedAt));
        refresh();
        setLastSyncError(null);
      } else if (count > 0 && !summary.serverUnavailable) {
        if (summary.failCount > 0 && summary.okCount === 0) {
          setLastSyncError("Cloud backup failed. Try Settings → Sync now.");
        }
      }
      updateSnapshotConflictHintFromPushSummary(summary);
    } catch {
      setLastSyncError("Cloud backup failed. Try again.");
    } finally {
      setSyncPhase("idle");
    }
  }, [status, db, online, refresh, updateSnapshotConflictHintFromPushSummary]);

  useEffect(() => {
    runPushAllSilentRef.current = runPushAllSilent;
  }, [runPushAllSilent]);

  useEffect(() => {
    flushDebouncedCloudPushBeforePullRef.current = async () => {
      if (debouncedPushTimerRef.current) {
        clearTimeout(debouncedPushTimerRef.current);
        debouncedPushTimerRef.current = null;
        await runPushAllSilentRef.current();
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      if (ablyPeerNudgeTimerRef.current) {
        clearTimeout(ablyPeerNudgeTimerRef.current);
        ablyPeerNudgeTimerRef.current = null;
      }
    };
  }, []);

  const scheduleCloudPush = useCallback(() => {
    if (status !== "authenticated" || !online) return;
    if (isAblyRealtimeSyncEnabled()) {
      const syncId = ablyEventSyncIdRef.current;
      if (syncId) {
        if (ablyPeerNudgeTimerRef.current) {
          clearTimeout(ablyPeerNudgeTimerRef.current);
        }
        ablyPeerNudgeTimerRef.current = setTimeout(() => {
          ablyPeerNudgeTimerRef.current = null;
          const sid = ablyEventSyncIdRef.current;
          if (!sid) return;
          void fetch("/api/ably/publish-event-nudge", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ eventSyncId: sid, scope: "data" }),
          }).catch(() => {});
        }, 350);
      }
    }
    if (debouncedPushTimerRef.current) {
      clearTimeout(debouncedPushTimerRef.current);
    }
    debouncedPushTimerRef.current = setTimeout(() => {
      debouncedPushTimerRef.current = null;
      void runPushAllSilentRef.current();
    }, 300);
  }, [status, online]);

  const ensureCloudBackupBeforeSignOut = useCallback(async (): Promise<boolean> => {
    if (status !== "authenticated" || !db) {
      showToast({
        kind: "error",
        message: "Sign out isn’t available right now. Try again.",
      });
      return false;
    }
    const eventCount = await db.events.count();
    if (eventCount === 0) {
      return true;
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      return window.confirm(
        "You’re offline. Local data may not be saved to the cloud yet. Sign out anyway?"
      );
    }
    if (debouncedPushTimerRef.current) {
      clearTimeout(debouncedPushTimerRef.current);
      debouncedPushTimerRef.current = null;
    }
    setSyncPhase("pushing");
    try {
      if (isSyncOpsEnabled()) {
        await pushAllPendingOps(db);
      }
      const summary = await pushAllLocalEvents(db);
      if (summary.serverUnavailable) {
        setCloudSyncAvailable(false);
        return window.confirm(
          "Cloud backup isn’t available on this server. Sign out anyway?"
        );
      }
      const fullySynced =
        summary.okCount === eventCount &&
        summary.failCount === 0 &&
        summary.conflictCount === 0;
      if (summary.lastUpdatedAt) {
        setLastPushAt(new Date(summary.lastUpdatedAt));
        refresh();
      }
      updateSnapshotConflictHintFromPushSummary(summary);
      if (fullySynced) {
        setLastSyncError(null);
        showToast({
          kind: "success",
          message: "Latest data saved to your account. Signing you out…",
        });
        return true;
      }
      if (summary.okCount > 0) {
        showToast({
          kind: "success",
          message: `${summary.okCount} of ${eventCount} event(s) saved. Signing you out…`,
        });
        return true;
      }
      return window.confirm(
        "Some event data could not be saved to the cloud. Sign out anyway?"
      );
    } catch {
      return window.confirm(
        "Could not reach cloud backup. Sign out anyway?"
      );
    } finally {
      setSyncPhase("idle");
    }
  }, [status, db, refresh, showToast, updateSnapshotConflictHintFromPushSummary]);

  useEffect(() => {
    const flush = () => {
      if (debouncedPushTimerRef.current) {
        clearTimeout(debouncedPushTimerRef.current);
        debouncedPushTimerRef.current = null;
      }
      if (
        status !== "authenticated" ||
        !dbReady ||
        !db ||
        (typeof navigator !== "undefined" && !navigator.onLine)
      ) {
        return;
      }
      void runPushAllSilentRef.current();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [status, db, dbReady]);

  const runBackgroundSyncCycle = useCallback(async () => {
    if (syncCycleLockRef.current) return;
    if (status !== "authenticated" || !dbReady || !db || !online) return;
    syncCycleLockRef.current = true;
    try {
      await flushDebouncedCloudPushBeforePullRef.current();
      await runPullAndMaybeSwitchEvent();
      if (db && isSyncOpsEnabled()) {
        const opSummary = await runOperationLevelSync(db);
        if (opSummary.pulledApplied > 0) {
          refresh();
        }
      }
      await runPushAllSilent();
      if (db) {
        await syncDirectoryWithCloud(db);
      }
    } finally {
      syncCycleLockRef.current = false;
    }
  }, [
    status,
    dbReady,
    db,
    online,
    runPullAndMaybeSwitchEvent,
    runPushAllSilent,
    refresh,
  ]);

  useEffect(() => {
    runBackgroundSyncCycleRef.current = runBackgroundSyncCycle;
  }, [runBackgroundSyncCycle]);

  useEffect(() => {
    if (!isAblyRealtimeSyncEnabled()) return;
    if (status !== "authenticated" || !online) return;
    const vendorRaw = session?.user?.vendorId;
    if (!vendorRaw) return;
    const vendorId = parseInt(vendorRaw, 10);
    if (!Number.isFinite(vendorId)) return;

    const scheduleNudgedSync = () => {
      if (ablyDebounceTimerRef.current) {
        clearTimeout(ablyDebounceTimerRef.current);
      }
        ablyDebounceTimerRef.current = setTimeout(() => {
        ablyDebounceTimerRef.current = null;
        void (async () => {
          const d = dbRef.current;
          const eid = currentEventIdRef.current;
          const ownPushEcho =
            Date.now() - lastOwnSnapshotPushAtRef.current < 2_000;
          if (d && eid != null && !ownPushEcho) {
            await flushDebouncedCloudPushBeforePullRef.current();
            const rr = await refreshEventFromCloudIfServerNewer(d, eid);
            if (rr.refreshed) refreshForSyncRef.current();
          }
          if (!ownPushEcho) {
            await runBackgroundSyncCycleRef.current();
          }
        })();
      }, 400);
    };

    const realtime = new Ably.Realtime({
      authCallback: (_tokenParams, callback) => {
        void (async () => {
          try {
            const res = await fetch("/api/ably/auth", {
              method: "POST",
              credentials: "include",
            });
            if (!res.ok) {
              callback(`Ably auth failed (${res.status})`, null);
              return;
            }
            const tokenRequest = await res.json();
            callback(null, tokenRequest as never);
          } catch (e) {
            callback(
              e instanceof Error ? e.message : "Ably auth request failed",
              null
            );
          }
        })();
      },
    });

    const announceCh = realtime.channels.get(GLOBAL_ANNOUNCE_CHANNEL);
    const onAnnounce = (msg: { data?: unknown }) => {
      handleAblyAnnounceMessage(msg.data, showToast);
    };
    void announceCh.subscribe("announce", onAnnounce).catch((e: unknown) => {
      console.error("[ably] announce subscribe failed", e);
    });

    const syncId = currentEvent?.syncId?.trim();
    let eventCh: ReturnType<typeof realtime.channels.get> | null = null;
    const onSync = () => {
      scheduleNudgedSync();
    };
    if (syncId) {
      const channelName = eventSyncChannelName(vendorId, syncId);
      eventCh = realtime.channels.get(channelName);
      void eventCh.subscribe("sync", onSync).catch((e: unknown) => {
        console.error("[ably] event sync subscribe failed", e);
      });
    }

    return () => {
      if (ablyDebounceTimerRef.current) {
        clearTimeout(ablyDebounceTimerRef.current);
        ablyDebounceTimerRef.current = null;
      }
      announceCh.unsubscribe("announce", onAnnounce);
      if (eventCh) {
        eventCh.unsubscribe("sync", onSync);
      }
      realtime.close();
    };
  }, [status, online, session?.user?.vendorId, currentEvent?.syncId, showToast]);

  /**
   * As soon as the signed-in user’s Dexie DB is ready, run one full sync cycle.
   * Otherwise the first pull waited on a 3s timer and the UI could stay empty
   * on a second device even though backups exist on the server.
   */
  const didImmediatePostDbReadySyncRef = useRef(false);
  /** New login or different account must be allowed to run immediate sync again. */
  useEffect(() => {
    didImmediatePostDbReadySyncRef.current = false;
  }, [session?.user?.id]);
  useEffect(() => {
    if (didImmediatePostDbReadySyncRef.current) return;
    if (status !== "authenticated" || !dbReady || !db || !online) {
      return;
    }
    didImmediatePostDbReadySyncRef.current = true;
    lastSuccessfulPullListAtRef.current = 0;
    void runBackgroundSyncCycle();
  }, [status, dbReady, db, online, runBackgroundSyncCycle]);

  useEffect(() => {
    const fn = () => setOnline(navigator.onLine);
    window.addEventListener("online", fn);
    window.addEventListener("offline", fn);
    return () => {
      window.removeEventListener("online", fn);
      window.removeEventListener("offline", fn);
    };
  }, []);

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void runBackgroundSyncCycle();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [runBackgroundSyncCycle]);

  useEffect(() => {
    const onOnline = () => {
      void runBackgroundSyncCycle();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [runBackgroundSyncCycle]);

  useEffect(() => {
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    if (status !== "authenticated" || !dbReady || !db || !online) {
      return;
    }
    syncIntervalRef.current = setInterval(() => {
      void runBackgroundSyncCycle();
    }, PUSH_ALL_INTERVAL_MS);
    const t = setTimeout(() => void runBackgroundSyncCycle(), 3_000);
    return () => {
      if (syncIntervalRef.current) clearInterval(syncIntervalRef.current);
      clearTimeout(t);
    };
  }, [status, db, dbReady, online, runBackgroundSyncCycle]);

  const runPushCurrent = useCallback(
    async (options?: { force?: boolean }): Promise<PushResult> => {
      if (
        status !== "authenticated" ||
        !db ||
        currentEventId == null ||
        !online
      ) {
        return { ok: false, message: "You are offline or no event selected." };
      }
      try {
        const result = await pushEventWithAutoMerge(db, currentEventId, options);
        if (result.ok) {
          if (!result.unchanged) {
            lastOwnSnapshotPushAtRef.current = Date.now();
            await recordSuccessfulPush(db, currentEventId, result.updatedAt);
            refresh();
          }
          setLastPushAt(new Date(result.updatedAt));
          setRemoteCloudSnapshotAt(null);
          setLastSyncError(null);
          return { ok: true };
        }
        if (result.conflict) {
          setRemoteCloudSnapshotAt(result.serverUpdatedAt ?? "unknown");
          return {
            ok: false,
            message:
              "Auto-merge could not resolve the conflict. Try Restore from cloud or push with force to overwrite.",
          };
        }
        if (result.status === 503) setCloudSyncAvailable(false);
        return {
          ok: false,
          message:
            result.status === 503
              ? "Cloud backup is not set up on the server yet."
              : "Cloud backup failed. Try again.",
        };
      } catch {
        return { ok: false, message: "Cloud backup failed. Try again." };
      }
    },
    [status, db, currentEventId, online, refresh]
  );

  const pushNow = useCallback(
    async (options?: { force?: boolean }) => {
      if (status !== "authenticated" || !db || !online) {
        showToast({
          kind: "error",
          message: "You must be online to back up to the cloud.",
        });
        return false;
      }
      const count = await db.events.count();
      if (count === 0) {
        showToast({
          kind: "error",
          message: "Create an event before backing up to the cloud.",
        });
        return false;
      }
      setSyncPhase("pushing");
      try {
        if (isSyncOpsEnabled()) {
          await pushAllPendingOps(db);
        }
        const summary = await pushAllLocalEvents(db, options);
        if (summary.serverUnavailable) setCloudSyncAvailable(false);
        if (summary.lastUpdatedAt) {
          setLastPushAt(new Date(summary.lastUpdatedAt));
          refresh();
        }
        updateSnapshotConflictHintFromPushSummary(summary);
        if (summary.serverUnavailable) {
          showToast({
            kind: "error",
            message: "Cloud backup is not set up on the server yet.",
          });
          return false;
        }
        if (summary.failCount === 0) {
          if (summary.conflictCount > 0) {
            showToast({
              kind: "success",
              message: `${summary.okCount} event(s) saved. ${summary.conflictCount} conflict(s) could not auto-merge — check the sync indicator or Settings.`,
            });
          } else {
            showToast({
              kind: "success",
              message: `Saved ${summary.okCount} event(s) to cloud backup.`,
            });
          }
          setLastSyncError(null);
          return true;
        }
        if (summary.okCount > 0) {
          showToast({
            kind: "success",
            message: `Partial backup: ${summary.okCount} saved, ${summary.failCount} failed.`,
          });
          setLastSyncError(null);
          return true;
        }
        showToast({
          kind: "error",
          message: "Cloud backup failed. Try again.",
        });
        return false;
      } catch {
        showToast({ kind: "error", message: "Cloud backup failed. Try again." });
        return false;
      } finally {
        setSyncPhase("idle");
      }
    },
    [status, db, online, refresh, showToast, updateSnapshotConflictHintFromPushSummary]
  );

  const restoreFromCloud = useCallback(async () => {
    if (!db || currentEventId == null || !currentEvent?.syncId) return false;
    try {
      const r = await restoreEventFromCloud(
        db,
        currentEventId,
        currentEvent.syncId
      );
      if (!r.ok) {
        showToast({ kind: "error", message: "Could not restore from cloud." });
        return false;
      }
      await ensureSettingsRow(db);
      await db.settings.update(1, { lastCloudPullAt: new Date(r.updatedAt) });
      setLastPullAt(new Date(r.updatedAt));
      refresh();
      setRemoteCloudSnapshotAt(null);
      setLastSyncError(null);
      showToast({
        kind: "success",
        message: "Restored event from cloud backup.",
      });
      return true;
    } catch {
      showToast({ kind: "error", message: "Restore failed." });
      return false;
    }
  }, [db, currentEventId, currentEvent?.syncId, refresh, showToast]);

  const dismissRemoteCloudSnapshotHint = useCallback(
    () => setRemoteCloudSnapshotAt(null),
    []
  );

  const ctxValue = useMemo<CloudSyncContextValue>(
    () => ({
      pushNow,
      restoreFromCloud,
      lastPushAt,
      lastPullAt,
      online,
      syncPhase,
      lastSyncError,
      cloudSyncAvailable,
      scheduleCloudPush,
      ensureCloudBackupBeforeSignOut,
      remoteCloudSnapshotAt,
      dismissRemoteCloudSnapshotHint,
    }),
    [
      pushNow,
      restoreFromCloud,
      lastPushAt,
      lastPullAt,
      online,
      syncPhase,
      lastSyncError,
      cloudSyncAvailable,
      scheduleCloudPush,
      ensureCloudBackupBeforeSignOut,
      remoteCloudSnapshotAt,
      dismissRemoteCloudSnapshotHint,
    ]
  );

  const impersonationBanner =
    session?.impersonatedByUserId != null ? <ImpersonationBanner /> : null;

  const topBanner = impersonationBanner ? (
    <div className="space-y-3">{impersonationBanner}</div>
  ) : null;

  return (
    <CloudSyncContext.Provider value={ctxValue}>
      <AppShell topBanner={topBanner}>
        {children}
      </AppShell>
    </CloudSyncContext.Provider>
  );
}
