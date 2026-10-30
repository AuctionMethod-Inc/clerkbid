import type { AuctionDB } from "@/lib/db";
import { applyRemoteOp } from "@/lib/sync/ops/applyRemoteOp";
import { isSyncOpsEnabled } from "@/lib/sync/syncOpsFlag";
import type { SyncOpPushItem } from "@/lib/sync/ops/types";

/** The push route rejects requests with more ops than this. */
export const PUSH_BATCH_SIZE = 200;

type PullOpRow = {
  id: string;
  opId: string;
  opType: string;
  payload: unknown;
  clientCreatedAt: string;
};

export async function pushPendingOpsForEvent(
  db: AuctionDB,
  eventSyncId: string
): Promise<{ ok: boolean; status: number; pushed: number }> {
  if (!isSyncOpsEnabled()) return { ok: true, status: 200, pushed: 0 };
  const pending = await db.syncOutbox
    .where("eventSyncId")
    .equals(eventSyncId)
    .sortBy("id");
  if (pending.length === 0) return { ok: true, status: 200, pushed: 0 };

  let pushed = 0;
  for (let i = 0; i < pending.length; i += PUSH_BATCH_SIZE) {
    const batch = pending.slice(i, i + PUSH_BATCH_SIZE);
    const items: SyncOpPushItem[] = batch.map((row) => ({
      opId: row.opId,
      eventSyncId: row.eventSyncId,
      opType: row.opType,
      clientCreatedAt:
        row.createdAt instanceof Date
          ? row.createdAt.toISOString()
          : String(row.createdAt),
      body: row.body,
    }));

    const res = await fetch("/api/sync/ops/push/", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventSyncId, ops: items }),
    });
    // Stop at the first failed batch so later ops never land before earlier ones.
    if (!res.ok) {
      return { ok: false, status: res.status, pushed };
    }
    const data = (await res.json()) as { acceptedOpIds?: string[] };
    const accepted = new Set(data.acceptedOpIds ?? []);
    for (const row of batch) {
      if (accepted.has(row.opId) && row.id != null) {
        await db.syncOutbox.delete(row.id);
      }
    }
    pushed += accepted.size;
  }
  return { ok: true, status: 200, pushed };
}

export async function pullAndApplyOpsForEvent(
  db: AuctionDB,
  eventSyncId: string
): Promise<{ applied: number; conflicts: number }> {
  if (!isSyncOpsEnabled()) return { applied: 0, conflicts: 0 };
  const eventRow = await db.events.where("syncId").equals(eventSyncId).first();
  if (!eventRow?.id) return { applied: 0, conflicts: 0 };

  let state = await db.syncState.get(eventSyncId);
  let afterId = state?.lastServerOpId ?? "0";

  let applied = 0;
  let conflicts = 0;

  for (let guard = 0; guard < 50; guard++) {
    const qs = new URLSearchParams({
      eventSyncId,
      afterId,
      limit: "100",
    });
    const res = await fetch(`/api/sync/ops/pull/?${qs}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) break;
    const data = (await res.json()) as { ops: PullOpRow[] };
    const ops = data.ops ?? [];
    if (ops.length === 0) break;

    for (const op of ops) {
      const freshEvent = await db.events.get(eventRow.id!);
      if (!freshEvent?.id) break;
      const r = await applyRemoteOp(
        db,
        freshEvent,
        eventSyncId,
        op.opType,
        op.payload
      );
      if (r.ok) {
        applied += 1;
      } else if ("conflict" in r && r.conflict) {
        conflicts += 1;
      }
      afterId = op.id;
    }

    await db.syncState.put({
      eventSyncId,
      lastServerOpId: afterId,
      updatedAt: new Date(),
    });

    if (ops.length < 100) break;
  }

  return { applied, conflicts };
}

/**
 * Push outbox + pull remote ops for every local event (when op sync is enabled).
 */
/** Push local outbox only (no pull). Used after edits so ops upload with debounced snapshot push. */
export async function pushAllPendingOps(db: AuctionDB): Promise<void> {
  if (!isSyncOpsEnabled()) return;
  const events = await db.events.toArray();
  for (const ev of events) {
    const sid = ev.syncId?.trim();
    if (!sid) continue;
    await pushPendingOpsForEvent(db, sid);
  }
}

export async function runOperationLevelSync(
  db: AuctionDB
): Promise<{
  pulledApplied: number;
  conflicts: number;
  pushFailures: number;
}> {
  if (!isSyncOpsEnabled()) {
    return { pulledApplied: 0, conflicts: 0, pushFailures: 0 };
  }
  const events = await db.events.toArray();
  let pulledApplied = 0;
  let conflicts = 0;
  let pushFailures = 0;

  for (const ev of events) {
    const sid = ev.syncId?.trim();
    if (!sid) continue;
    const pull = await pullAndApplyOpsForEvent(db, sid);
    pulledApplied += pull.applied;
    conflicts += pull.conflicts;
    const push = await pushPendingOpsForEvent(db, sid);
    if (!push.ok && push.status !== 200) {
      pushFailures += 1;
    }
  }

  return { pulledApplied, conflicts, pushFailures };
}
