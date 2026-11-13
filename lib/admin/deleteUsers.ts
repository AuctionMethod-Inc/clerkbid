import { sql, withTransaction, type TxClient } from "@/lib/db/postgres";
import {
  buildDeletePlan,
  sameIdSet,
  type DeletePlan,
  type DeleteTarget,
  type DeleteVendorInfo,
} from "@/lib/admin/deleteUsersPlan";

type Db = Pick<TxClient, "sql">;

/** Postgres array literal for `= ANY(${...}::int[])`; ids are validated integers. */
function intArray(ids: readonly number[]): string {
  return `{${ids.join(",")}}`;
}

export class PlanChangedError extends Error {
  constructor() {
    super("The affected organizations changed since the preview.");
    this.name = "PlanChangedError";
  }
}

async function loadPlan(
  db: Db,
  requestedIds: readonly number[],
  adminId: number,
  lockRows: boolean
): Promise<DeletePlan> {
  const ids = intArray(requestedIds);
  const { rows: found } = lockRows
    ? await db.sql<DeleteTarget>`
        SELECT id, email, first_name, last_name, vendor_id, org_role
        FROM users WHERE id = ANY(${ids}::int[])
        ORDER BY id FOR UPDATE
      `
    : await db.sql<DeleteTarget>`
        SELECT id, email, first_name, last_name, vendor_id, org_role
        FROM users WHERE id = ANY(${ids}::int[])
        ORDER BY id
      `;

  const vendorIds = Array.from(new Set(found.map((u) => u.vendor_id)));
  let vendors: DeleteVendorInfo[] = [];
  if (vendorIds.length > 0) {
    const vids = intArray(vendorIds);
    const { rows: vrows } = await db.sql<{
      id: number;
      name: string;
      slug: string;
      synced_events: number;
      sync_ops: number;
    }>`
      SELECT
        v.id,
        v.name,
        v.slug,
        (SELECT COUNT(*) FROM event_cloud_snapshots s WHERE s.vendor_id = v.id)::int AS synced_events,
        (SELECT COUNT(*) FROM event_sync_ops o WHERE o.vendor_id = v.id)::int AS sync_ops
      FROM vendors v
      WHERE v.id = ANY(${vids}::int[])
      ORDER BY v.id
    `;
    const { rows: members } = await db.sql<{
      id: number;
      vendor_id: number;
      org_role: string;
    }>`
      SELECT id, vendor_id, org_role FROM users
      WHERE vendor_id = ANY(${vids}::int[])
    `;
    vendors = vrows.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      syncedEvents: v.synced_events,
      syncOps: v.sync_ops,
      members: members
        .filter((m) => m.vendor_id === v.id)
        .map((m) => ({ id: m.id, org_role: m.org_role })),
    }));
  }

  return buildDeletePlan({ requestedIds, adminId, found, vendors });
}

/** Read-only: what would deleting these users do? */
export function previewUserDeletion(
  userIds: readonly number[],
  adminId: number
): Promise<DeletePlan> {
  return loadPlan({ sql }, userIds, adminId, false);
}

export type DeleteResult =
  | { ok: true; plan: DeletePlan }
  | { ok: false; plan: DeletePlan };

/**
 * Deletes the users, and any organization left with no members, in one
 * transaction. The plan is recomputed under row locks and must still delete
 * exactly `expectedOrgIds` organizations, so a stale preview cannot remove an
 * organization the admin did not see. Returns `ok: false` (nothing deleted)
 * when any requested user is blocked; throws {@link PlanChangedError} when the
 * organizations differ from the preview.
 */
export function deleteUsers(
  userIds: readonly number[],
  adminId: number,
  expectedOrgIds: readonly number[]
): Promise<DeleteResult> {
  return withTransaction(async (client) => {
    const plan = await loadPlan(client, userIds, adminId, true);
    if (plan.blocked.length > 0) return { ok: false, plan };

    if (
      !sameIdSet(
        plan.orgsToDelete.map((o) => o.id),
        expectedOrgIds
      )
    ) {
      throw new PlanChangedError();
    }

    await client.sql`
      DELETE FROM users WHERE id = ANY(${intArray(
        plan.deletable.map((u) => u.id)
      )}::int[])
    `;
    if (plan.orgsToDelete.length > 0) {
      // One statement however many orgs. Guarded: never drop an organization
      // that still has a member.
      await client.sql`
        DELETE FROM vendors v
        WHERE v.id = ANY(${intArray(
          plan.orgsToDelete.map((o) => o.id)
        )}::int[])
          AND NOT EXISTS (SELECT 1 FROM users u WHERE u.vendor_id = v.id)
      `;
    }
    return { ok: true, plan };
  });
}
