import type { AuctionDB } from "@/lib/db";
import { isCloudEventSyncIdTombstoned } from "@/lib/services/cloudDeleteTombstone";
import { ensureSettingsRow } from "@/lib/settings";
import {
  buildEventExport,
  importEventFromPayload,
  parseEventExportPayload,
  replaceEventFromPayload,
  type EventExportPayload,
} from "@/lib/services/dataPorter";
import { mergeServerSnapshotIntoLocal } from "@/lib/services/snapshotMerge";
import { isSyncOpsEnabled } from "@/lib/sync/syncOpsFlag";

export type SyncListEntry = { eventSyncId: string; updatedAt: string };

/**
 * True when the server snapshot is strictly newer than our local merge baseline.
 * Uses the later of `lastCloudPullAt` and `lastCloudPushAt` so a snapshot we
 * just pushed is not treated as remote-newer (which would delete+reinsert rows).
 * If both are missing, false.
 */
export function isServerSnapshotNewerThanLocalBaseline(
  serverUpdatedAtIso: string,
  localLastCloudPullAt: Date | undefined,
  localLastCloudPushAt: Date | undefined
): boolean {
  const serverMs = new Date(serverUpdatedAtIso).getTime();
  if (!Number.isFinite(serverMs)) return false;
  const pullMs = localLastCloudPullAt?.getTime();
  const pushMs = localLastCloudPushAt?.getTime();
  const candidates = [pullMs, pushMs].filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n)
  );
  if (candidates.length === 0) return false;
  const baseline = Math.max(...candidates);
  return serverMs > baseline;
}

/**
 * True when local event data may not yet be reflected on the server snapshot,
 * so a full replace would drop recent bidders/sales/etc.
 * - After a successful snapshot push: `updatedAt` vs `lastCloudPushAt`.
 * - If we have never snapshot-pushed: `updatedAt` vs `lastCloudPullAt` (requires
 *   post-pull `events.updatedAt` to match server snapshot time — see refresh paths).
 */
export function hasUnpushedLocalEventMetadataEdits(ev: {
  updatedAt: Date;
  lastCloudPushAt?: Date;
  lastCloudPullAt?: Date;
}): boolean {
  const u = ev.updatedAt.getTime();
  if (ev.lastCloudPushAt != null && u > ev.lastCloudPushAt.getTime()) {
    return true;
  }
  if (ev.lastCloudPullAt != null && u > ev.lastCloudPullAt.getTime()) {
    return true;
  }
  return false;
}

/** Op-sync outbox rows must not be dropped by a full snapshot replace. */
export function shouldBlockAutoSnapshotReplace(
  syncOpsEnabled: boolean,
  pendingOutboxCount: number
): boolean {
  return syncOpsEnabled && pendingOutboxCount > 0;
}

async function canAutoReplaceSnapshotForEvent(
  db: AuctionDB,
  eventSyncId: string
): Promise<boolean> {
  const pending = await db.syncOutbox
    .where("eventSyncId")
    .equals(eventSyncId)
    .count();
  return !shouldBlockAutoSnapshotReplace(isSyncOpsEnabled(), pending);
}

export type RefreshEventFromCloudResult =
  | { refreshed: true }
  | {
      refreshed: false;
      reason:
        | "no_event"
        | "no_sync_id"
        | "outbox_pending"
        | "fetch_failed"
        | "not_newer"
        | "local_unpushed_edit";
    };

/**
 * If the server snapshot is newer than our baseline (`lastCloudPullAt`, else
 * `lastCloudPushAt`), merge server entities into local Dexie. Auto-refresh
 * never full-replaces (that delete+reinsert remounts invoice rows). Explicit
 * Restore still uses `replaceEventFromPayload`.
 * Skips when op-sync is on and this event has pending outbox rows.
 */
export async function refreshEventFromCloudIfServerNewer(
  db: AuctionDB,
  eventId: number
): Promise<RefreshEventFromCloudResult> {
  const ev = await db.events.get(eventId);
  if (ev?.id == null) return { refreshed: false, reason: "no_event" };
  const syncId = ev.syncId?.trim();
  if (!syncId) return { refreshed: false, reason: "no_sync_id" };
  if (!(await canAutoReplaceSnapshotForEvent(db, syncId))) {
    return { refreshed: false, reason: "outbox_pending" };
  }
  const snap = await fetchEventSnapshot(syncId);
  if (!snap.ok) return { refreshed: false, reason: "fetch_failed" };
  if (
    !isServerSnapshotNewerThanLocalBaseline(
      snap.updatedAt,
      ev.lastCloudPullAt,
      ev.lastCloudPushAt
    )
  ) {
    return { refreshed: false, reason: "not_newer" };
  }
  await mergeServerSnapshotIntoLocal(db, eventId, snap.payload, {
    applyServerLinks: true,
  });
  const serverTime = new Date(snap.updatedAt);
  await db.events.update(eventId, {
    lastCloudPullAt: serverTime,
    updatedAt: serverTime,
  });
  return { refreshed: true };
}

/**
 * For each cloud list entry that matches a local event, pull the snapshot when the server
 * copy is newer than the local baseline and merge it in (never auto-replace).
 */
export async function refreshStaleLocalEventsFromList(
  db: AuctionDB,
  listEntries: SyncListEntry[]
): Promise<{ refreshed: number; skipped: number; latestPullAt: Date | null }> {
  let refreshed = 0;
  let skipped = 0;
  let latestPullAt: Date | null = null;

  for (const entry of listEntries) {
    const local = await db.events
      .where("syncId")
      .equals(entry.eventSyncId)
      .first();
    if (local?.id == null) {
      skipped += 1;
      continue;
    }
    if (
      !isServerSnapshotNewerThanLocalBaseline(
        entry.updatedAt,
        local.lastCloudPullAt,
        local.lastCloudPushAt
      )
    ) {
      skipped += 1;
      continue;
    }
    if (!(await canAutoReplaceSnapshotForEvent(db, entry.eventSyncId))) {
      skipped += 1;
      continue;
    }
    const snap = await fetchEventSnapshot(entry.eventSyncId);
    if (!snap.ok) {
      skipped += 1;
      continue;
    }
    if (
      !isServerSnapshotNewerThanLocalBaseline(
        snap.updatedAt,
        local.lastCloudPullAt,
        local.lastCloudPushAt
      )
    ) {
      skipped += 1;
      continue;
    }
    await mergeServerSnapshotIntoLocal(db, local.id, snap.payload, {
      applyServerLinks: true,
    });
    const serverTime = new Date(snap.updatedAt);
    await db.events.update(local.id, {
      lastCloudPullAt: serverTime,
      updatedAt: serverTime,
    });
    refreshed += 1;
    if (
      latestPullAt == null ||
      serverTime.getTime() > latestPullAt.getTime()
    ) {
      latestPullAt = serverTime;
    }
  }

  if (latestPullAt != null) {
    await ensureSettingsRow(db);
    await db.settings.update(1, { lastCloudPullAt: latestPullAt });
  }

  return { refreshed, skipped, latestPullAt };
}

export async function fetchSyncList(): Promise<
  { ok: true; events: SyncListEntry[] } | { ok: false; status: number }
> {
  const res = await fetch("/api/sync/list/", {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as { events: SyncListEntry[] };
  return { ok: true, events: data.events ?? [] };
}

/**
 * The cloud version this device last downloaded or saved (later of pull and
 * push), sent with a save so the server can refuse one that never saw newer
 * cloud changes. Null when this device has neither.
 */
export function cloudBaseUpdatedAt(ev: {
  lastCloudPullAt?: Date;
  lastCloudPushAt?: Date;
}): string | null {
  const times = [ev.lastCloudPullAt, ev.lastCloudPushAt]
    .map((d) => d?.getTime())
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

export async function pushEventSnapshot(
  payload: EventExportPayload,
  options?: { force?: boolean; baseUpdatedAt?: string | null }
): Promise<
  | { ok: true; updatedAt: string; unchanged?: boolean }
  | { ok: false; status: number; conflict?: boolean; serverUpdatedAt?: string }
> {
  const res = await fetch("/api/sync/push/", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventSyncId: payload.event.syncId,
      payload,
      clientExportedAt: payload.exportDate,
      force: options?.force === true,
      ...(options && "baseUpdatedAt" in options
        ? { baseUpdatedAt: options.baseUpdatedAt }
        : {}),
    }),
  });
  if (res.status === 409) {
    const data = (await res.json()) as { serverUpdatedAt?: string };
    return {
      ok: false,
      status: 409,
      conflict: true,
      serverUpdatedAt: data.serverUpdatedAt,
    };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as { updatedAt: string; unchanged?: boolean };
  return {
    ok: true,
    updatedAt: data.updatedAt,
    unchanged: data.unchanged === true,
  };
}

/** Removes the server snapshot and op log for this event (org-scoped). */
export async function deleteCloudEventBackup(
  syncId: string
): Promise<{ ok: true } | { ok: false; status: number }> {
  const id = syncId.trim();
  if (!id) return { ok: false, status: 400 };
  const res = await fetch(
    `/api/sync/event/?syncId=${encodeURIComponent(id)}`,
    { method: "DELETE", credentials: "include", cache: "no-store" }
  );
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true };
}

export async function fetchEventSnapshot(syncId: string): Promise<
  | { ok: true; payload: EventExportPayload; updatedAt: string }
  | { ok: false; status: number }
> {
  const res = await fetch(
    `/api/sync/event/?syncId=${encodeURIComponent(syncId)}`,
    { credentials: "include", cache: "no-store" }
  );
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as {
    payload: unknown;
    updatedAt: string;
  };
  try {
    const payload = parseEventExportPayload(data.payload);
    return { ok: true, payload, updatedAt: data.updatedAt };
  } catch {
    return { ok: false, status: 422 };
  }
}

export async function pushCurrentEvent(
  db: AuctionDB,
  eventId: number,
  options?: { force?: boolean; baseUpdatedAt?: string | null }
): Promise<
  | { ok: true; updatedAt: string; unchanged?: boolean }
  | { ok: false; status: number; conflict?: boolean; serverUpdatedAt?: string }
> {
  // Read the base before exporting: a refresh landing in between then only
  // makes the base older than the export (a harmless refused save), never newer.
  const ev = await db.events.get(eventId);
  const baseUpdatedAt =
    options?.baseUpdatedAt !== undefined
      ? options.baseUpdatedAt
      : ev
        ? cloudBaseUpdatedAt(ev)
        : null;
  const payload = await buildEventExport(db, eventId);
  if (!payload.event.syncId) {
    return { ok: false, status: 400 };
  }
  return pushEventSnapshot(payload, { ...options, baseUpdatedAt });
}

/** Refused-save retries before reporting a conflict (each one re-merges). */
const MAX_MERGE_ATTEMPTS = 3;

/**
 * Push an event snapshot, automatically merging on conflict: if the cloud has
 * changed since this device last saw it (409), pull it, merge entities into
 * local Dexie, re-export, and save again from the version just merged. If the
 * cloud moves again meanwhile, repeat a few times, then report the conflict.
 * A forced push never conflicts and overwrites the cloud copy.
 */
export async function pushEventWithAutoMerge(
  db: AuctionDB,
  eventId: number,
  options?: { force?: boolean }
): Promise<
  | { ok: true; updatedAt: string; autoMerged: boolean; unchanged?: boolean }
  | { ok: false; status: number; conflict?: boolean; serverUpdatedAt?: string }
> {
  const firstTry = await pushCurrentEvent(db, eventId, options);
  if (firstTry.ok) return { ...firstTry, autoMerged: false };
  if (!firstTry.conflict) return firstTry;

  const ev = await db.events.get(eventId);
  if (!ev) return firstTry;
  const syncId = ev.syncId?.trim();
  if (!syncId) return firstTry;

  // A device with unsaved edits keeps its own event settings through the
  // merge; otherwise the retry save would undo a settings change made here.
  const keepLocalEventSettings = hasUnpushedLocalEventMetadataEdits(ev);
  // A cloud row this device lacks and that predates its last sync was deleted
  // here, so the merge must not bring it back.
  const lastSync = cloudBaseUpdatedAt(ev);
  const addMissingRowsCreatedAfter =
    lastSync != null ? new Date(lastSync) : undefined;
  let last = firstTry;
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt += 1) {
    const snap = await fetchEventSnapshot(syncId);
    if (!snap.ok) return last;

    try {
      await mergeServerSnapshotIntoLocal(db, eventId, snap.payload, {
        keepLocalEventSettings,
        addMissingRowsCreatedAfter,
      });
    } catch {
      return last;
    }

    const merged = await buildEventExport(db, eventId);
    const retry = await pushEventSnapshot(merged, {
      baseUpdatedAt: snap.updatedAt,
    });
    if (retry.ok) return { ...retry, autoMerged: true };
    if (!retry.conflict) return retry;
    last = retry;
  }
  return last;
}

export async function restoreEventFromCloud(
  db: AuctionDB,
  eventId: number,
  syncId: string
): Promise<
  { ok: true; updatedAt: string } | { ok: false; status: number }
> {
  const snap = await fetchEventSnapshot(syncId);
  if (!snap.ok) return { ok: false, status: snap.status };
  await replaceEventFromPayload(db, eventId, snap.payload);
  const serverTime = new Date(snap.updatedAt);
  await db.events.update(eventId, {
    lastCloudPullAt: serverTime,
    updatedAt: serverTime,
  });
  return { ok: true, updatedAt: snap.updatedAt };
}

export async function recordSuccessfulPush(
  db: AuctionDB,
  eventId: number,
  updatedAtIso: string
): Promise<void> {
  const t = new Date(updatedAtIso);
  // Align row tip with server so hasUnpushedLocalEventMetadataEdits stays false after
  // push (avoids client clock ahead of server blocking snapshot refresh forever).
  await db.events.update(eventId, {
    lastCloudPushAt: t,
    lastCloudPullAt: t,
    updatedAt: t,
  });
  await ensureSettingsRow(db);
  await db.settings.update(1, { lastCloudPushAt: t });
}

/**
 * Pushes one event's snapshot immediately and updates local push baselines.
 * Use after deletes that are not represented in the op log (e.g. bidders,
 * consignors) so the next pull/merge cannot resurrect rows from a stale snapshot.
 */
export async function flushSingleEventToCloudSnapshot(
  db: AuctionDB,
  eventId: number
): Promise<boolean> {
  const result = await pushEventWithAutoMerge(db, eventId);
  if (!result.ok) return false;
  if (!result.unchanged) {
    await recordSuccessfulPush(db, eventId, result.updatedAt);
  }
  return true;
}

/**
 * Import every cloud snapshot whose syncId is not already present locally.
 * Used so a second device/browser can hydrate from the server after login.
 * Pass the result of `fetchSyncList()` (when `ok`) so the list is not fetched twice.
 */
export async function pullCloudEventsMissingLocally(
  db: AuctionDB,
  listEntries: SyncListEntry[]
): Promise<{
  imported: number;
  alreadyLocal: number;
  fetchFailures: number;
}> {
  let imported = 0;
  let alreadyLocal = 0;
  let fetchFailures = 0;
  let latestPullAt: Date | null = null;

  for (const entry of listEntries) {
    const existing = await db.events
      .where("syncId")
      .equals(entry.eventSyncId)
      .first();
    if (existing) {
      alreadyLocal += 1;
      continue;
    }
    if (await isCloudEventSyncIdTombstoned(db, entry.eventSyncId)) {
      continue;
    }

    const snap = await fetchEventSnapshot(entry.eventSyncId);
    if (!snap.ok) {
      fetchFailures += 1;
      continue;
    }

    const summary = await importEventFromPayload(db, snap.payload);
    const serverTime = new Date(snap.updatedAt);
    await db.events.update(summary.eventId, {
      lastCloudPullAt: serverTime,
      updatedAt: serverTime,
    });
    latestPullAt = serverTime;
    imported += 1;
  }

  if (latestPullAt != null) {
    await ensureSettingsRow(db);
    await db.settings.update(1, { lastCloudPullAt: latestPullAt });
  }

  return { imported, alreadyLocal, fetchFailures };
}

export type SnapshotPushConflict = {
  eventId: number;
  serverUpdatedAt?: string;
};

export type PushAllSummary = {
  okCount: number;
  conflictCount: number;
  failCount: number;
  /** True if any failure was HTTP 503 (cloud tables / not configured). */
  serverUnavailable: boolean;
  /** Latest server updatedAt from any successful push, for UI. */
  lastUpdatedAt: string | null;
  /** Snapshot 409s by local event id (for UI: real save conflicts only). */
  snapshotConflicts: SnapshotPushConflict[];
  /** Event ids that successfully snapshot-pushed in this batch. */
  snapshotPushedOkEventIds: number[];
};

/**
 * Push a snapshot for every local event. On 409 conflict, automatically merges
 * the server snapshot into local data and retries. Only reports a conflict when
 * auto-merge itself fails.
 */
export async function pushAllLocalEvents(
  db: AuctionDB,
  options?: { force?: boolean }
): Promise<PushAllSummary> {
  const rows = await db.events.toArray();
  let okCount = 0;
  let conflictCount = 0;
  let failCount = 0;
  let serverUnavailable = false;
  let lastUpdatedAt: string | null = null;
  const snapshotConflicts: SnapshotPushConflict[] = [];
  const snapshotPushedOkEventIds: number[] = [];

  for (const ev of rows) {
    const id = ev.id;
    if (id == null) continue;

    const result = await pushEventWithAutoMerge(db, id, options);
    if (result.ok) {
      okCount += 1;
      if (!result.unchanged) {
        await recordSuccessfulPush(db, id, result.updatedAt);
        lastUpdatedAt = result.updatedAt;
        snapshotPushedOkEventIds.push(id);
      }
    } else if (result.conflict) {
      conflictCount += 1;
      snapshotConflicts.push({
        eventId: id,
        serverUpdatedAt: result.serverUpdatedAt,
      });
    } else {
      failCount += 1;
      if (result.status === 503) serverUnavailable = true;
    }
  }

  return {
    okCount,
    conflictCount,
    failCount,
    serverUnavailable,
    lastUpdatedAt,
    snapshotConflicts,
    snapshotPushedOkEventIds,
  };
}
