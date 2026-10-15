import type { AuctionDB } from "@/lib/db";
import {
  clearDirectoryDirty,
  ensureSettingsRow,
  markDirectoryDirty,
} from "@/lib/settings";
import {
  buildDirectoryExport,
  isDirectoryExportPayload,
  type DirectoryExportPayload,
} from "@/lib/directory/payload";
import { replaceDirectorySnapshot } from "@/lib/directory/merge";
import { consolidateDirectoryDuplicates } from "@/lib/directory/upsert";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";

function isNewer(serverIso: string, local?: Date): boolean {
  const serverMs = new Date(serverIso).getTime();
  if (!Number.isFinite(serverMs)) return false;
  if (local == null) return true;
  return serverMs > local.getTime();
}

export type DirectoryPushResult =
  | { ok: true; updatedAt: string; unchanged?: boolean }
  | {
      ok: false;
      status: number;
      stale?: boolean;
      updatedAt?: string;
      payload?: DirectoryExportPayload;
    };

export type DirectorySyncResult = {
  pulled: boolean;
  replaced: boolean;
  pushed: boolean;
  conflict: boolean;
  error?: string;
};

export async function fetchDirectorySnapshot(): Promise<
  | { ok: true; payload: DirectoryExportPayload; updatedAt: string }
  | { ok: false; status: number; missing?: boolean }
> {
  const res = await fetch("/api/sync/directory/", {
    credentials: "include",
    cache: "no-store",
  });
  if (res.status === 404) return { ok: false, status: 404, missing: true };
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as { payload: unknown; updatedAt: string };
  if (!isDirectoryExportPayload(data.payload)) {
    return { ok: false, status: 422 };
  }
  return { ok: true, payload: data.payload, updatedAt: data.updatedAt };
}

export async function pushDirectorySnapshot(
  payload: DirectoryExportPayload,
  baseUpdatedAt?: string | null
): Promise<DirectoryPushResult> {
  const res = await fetch("/api/sync/directory/", {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      payload,
      clientExportedAt: payload.exportDate,
      baseUpdatedAt: baseUpdatedAt ?? null,
    }),
  });
  if (res.status === 409) {
    const data = (await res.json()) as {
      error?: string;
      updatedAt?: string;
      payload?: unknown;
    };
    return {
      ok: false,
      status: 409,
      stale: true,
      updatedAt: data.updatedAt,
      payload: isDirectoryExportPayload(data.payload) ? data.payload : undefined,
    };
  }
  if (!res.ok) return { ok: false, status: res.status };
  const data = (await res.json()) as { updatedAt: string; unchanged?: boolean };
  return { ok: true, updatedAt: data.updatedAt, unchanged: data.unchanged };
}

async function applyRemoteDirectory(
  db: AuctionDB,
  payload: DirectoryExportPayload,
  updatedAt: string
): Promise<void> {
  await replaceDirectorySnapshot(db, payload);
  const t = new Date(updatedAt);
  await ensureSettingsRow(db);
  await db.settings.update(1, {
    lastDirectoryPullAt: t,
    lastDirectoryServerUpdatedAt: t,
    directoryDirty: false,
  });
}

/**
 * Pull remote Directory when newer than last synced server timestamp.
 * Replaces local masters (does not union-merge).
 */
export async function pullDirectoryFromCloud(db: AuctionDB): Promise<{
  ok: boolean;
  replaced: boolean;
}> {
  const snap = await fetchDirectorySnapshot();
  if (!snap.ok) return { ok: snap.missing === true, replaced: false };
  await ensureSettingsRow(db);
  const settings = await db.settings.get(1);
  const base =
    settings?.lastDirectoryServerUpdatedAt ??
    settings?.lastDirectoryPullAt ??
    settings?.lastDirectoryPushAt;
  if (!isNewer(snap.updatedAt, base)) {
    return { ok: true, replaced: false };
  }
  await applyRemoteDirectory(db, snap.payload, snap.updatedAt);
  return { ok: true, replaced: true };
}

/**
 * Push local Directory when dirty. Uses optimistic concurrency base.
 * On 409, replaces local from server payload (cloud wins).
 */
export async function pushDirectoryToCloud(
  db: AuctionDB,
  options?: { force?: boolean }
): Promise<DirectoryPushResult & { conflictReplaced?: boolean }> {
  await ensureSettingsRow(db);
  const settings = await db.settings.get(1);
  if (!options?.force && !settings?.directoryDirty) {
    const t = settings?.lastDirectoryServerUpdatedAt;
    return {
      ok: true,
      updatedAt: t ? t.toISOString() : new Date().toISOString(),
      unchanged: true,
    };
  }

  const [bidders, consignors] = await Promise.all([
    db.masterBidders.toArray(),
    db.masterConsignors.toArray(),
  ]);
  if (bidders.length === 0 && consignors.length === 0) {
    const existing = await fetchDirectorySnapshot();
    if (!existing.ok) {
      if (existing.missing || existing.status === 404) {
        await clearDirectoryDirty(db);
        return { ok: true, updatedAt: new Date().toISOString(), unchanged: true };
      }
      return { ok: false, status: existing.status };
    }
  }

  const payload = await buildDirectoryExport(bidders, consignors);
  const base =
    settings?.lastDirectoryServerUpdatedAt ??
    settings?.lastDirectoryPullAt ??
    settings?.lastDirectoryPushAt;
  const baseIso = base ? new Date(base).toISOString() : null;

  const result = await pushDirectorySnapshot(payload, baseIso);
  if (result.ok) {
    const t = new Date(result.updatedAt);
    await db.settings.update(1, {
      lastDirectoryPushAt: t,
      lastDirectoryPullAt: t,
      lastDirectoryServerUpdatedAt: t,
      directoryDirty: false,
    });
    return result;
  }

  if (result.stale) {
    let payloadToApply = result.payload;
    let updatedAt = result.updatedAt;
    if (!payloadToApply || !updatedAt) {
      const snap = await fetchDirectorySnapshot();
      if (snap.ok) {
        payloadToApply = snap.payload;
        updatedAt = snap.updatedAt;
      }
    }
    if (payloadToApply && updatedAt) {
      await applyRemoteDirectory(db, payloadToApply, updatedAt);
      return { ...result, conflictReplaced: true };
    }
  }

  return result;
}

/**
 * Collapse email/phone duplicate master rows; mark dirty and push when removed.
 */
export async function cleanupDirectoryDuplicates(
  db: AuctionDB
): Promise<{
  biddersRemoved: number;
  consignorsRemoved: number;
  pushed: boolean;
  conflict?: boolean;
}> {
  const result = await withCloudSyncApply(async () =>
    consolidateDirectoryDuplicates(db)
  );
  let pushed = false;
  let conflict = false;
  if (result.biddersRemoved > 0 || result.consignorsRemoved > 0) {
    await markDirectoryDirty(db);
    try {
      const push = await pushDirectoryToCloud(db);
      pushed = push.ok;
      conflict = Boolean(push.conflictReplaced);
    } catch {
      pushed = false;
    }
  }
  return { ...result, pushed, conflict };
}

/**
 * Fool-proof Directory sync: replace local if server newer; push only if dirty.
 */
export async function syncDirectoryWithCloud(
  db: AuctionDB
): Promise<DirectorySyncResult> {
  const out: DirectorySyncResult = {
    pulled: false,
    replaced: false,
    pushed: false,
    conflict: false,
  };

  try {
    const snap = await fetchDirectorySnapshot();
    if (!snap.ok) {
      out.pulled = snap.missing === true;
      if (snap.missing || snap.status === 404) {
        await ensureSettingsRow(db);
        const settings = await db.settings.get(1);
        const [bc, cc] = await Promise.all([
          db.masterBidders.count(),
          db.masterConsignors.count(),
        ]);
        if (
          bc + cc > 0 &&
          !settings?.lastDirectoryServerUpdatedAt &&
          !settings?.lastDirectoryPushAt
        ) {
          await markDirectoryDirty(db);
        }
      } else {
        out.error = `Directory pull failed (${snap.status}).`;
        return out;
      }
    } else {
      out.pulled = true;
      await ensureSettingsRow(db);
      const settings = await db.settings.get(1);
      const base =
        settings?.lastDirectoryServerUpdatedAt ??
        settings?.lastDirectoryPullAt ??
        settings?.lastDirectoryPushAt;
      if (isNewer(snap.updatedAt, base)) {
        await applyRemoteDirectory(db, snap.payload, snap.updatedAt);
        out.replaced = true;
      }
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : "Directory pull failed.";
    return out;
  }

  try {
    await cleanupDirectoryDuplicates(db);
  } catch {
    /* ignore */
  }

  await ensureSettingsRow(db);
  const settings = await db.settings.get(1);
  if (!settings?.directoryDirty) {
    return out;
  }

  try {
    const push = await pushDirectoryToCloud(db);
    if (push.ok) {
      out.pushed = !push.unchanged;
    } else if (push.conflictReplaced) {
      out.conflict = true;
    } else {
      out.error = `Directory push failed (${push.status}).`;
    }
  } catch (e) {
    out.error = e instanceof Error ? e.message : "Directory push failed.";
  }

  return out;
}

/**
 * Mark Directory dirty and push to cloud. Use after local master edits/deletes.
 * Returns push result; on conflict, local was replaced from cloud.
 */
export async function publishDirectoryChanges(
  db: AuctionDB
): Promise<DirectoryPushResult & { conflictReplaced?: boolean }> {
  await markDirectoryDirty(db);
  return pushDirectoryToCloud(db, { force: true });
}
