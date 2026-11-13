import { isSuperAdminUserIdAndEmail } from "@/lib/auth/superAdmin";

/** Upper bound for one request: keeps the transaction short and a slip small. */
export const MAX_DELETE_BATCH = 25;

export type DeleteTarget = {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  vendor_id: number;
  org_role: string;
};

export type DeleteVendorInfo = {
  id: number;
  name: string;
  slug: string;
  /** Every current member of the organization, not just the ones being deleted. */
  members: { id: number; org_role: string }[];
  syncedEvents: number;
  syncOps: number;
};

export type BlockReason = "self" | "super_admin" | "not_found";

export type DeletePlan = {
  deletable: DeleteTarget[];
  blocked: { id: number; reason: BlockReason }[];
  /** Organizations that end up with no members, so they are deleted with their backups. */
  orgsToDelete: DeleteVendorInfo[];
  /** Organizations that keep members but lose their only admin. */
  orgsLosingAdmin: DeleteVendorInfo[];
};

export type ParsedUserIds =
  | { ok: true; ids: number[] }
  | { ok: false; error: string };

/** Validates untrusted request input: a non-empty array of distinct positive integers. */
export function parseUserIds(raw: unknown): ParsedUserIds {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "userIds (non-empty array) is required." };
  }
  const ids: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, error: "userIds must be positive integers." };
    }
    if (!ids.includes(v)) ids.push(v);
  }
  if (ids.length > MAX_DELETE_BATCH) {
    return {
      ok: false,
      error: `Delete at most ${MAX_DELETE_BATCH} users at a time.`,
    };
  }
  return { ok: true, ids };
}

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  self: "You cannot delete your own account.",
  super_admin: "Super-admin accounts cannot be deleted from this panel.",
  not_found: "User not found (already deleted?).",
};

/**
 * Pure decision logic: given the requested ids, the rows that exist, and the
 * current membership of the affected organizations, work out what a deletion
 * would do. Callers refuse the whole request when anything is blocked.
 */
export function buildDeletePlan(input: {
  requestedIds: readonly number[];
  adminId: number;
  found: readonly DeleteTarget[];
  vendors: readonly DeleteVendorInfo[];
}): DeletePlan {
  const foundById = new Map(input.found.map((u) => [u.id, u]));
  const deletable: DeleteTarget[] = [];
  const blocked: DeletePlan["blocked"] = [];

  for (const id of input.requestedIds) {
    const u = foundById.get(id);
    if (id === input.adminId) blocked.push({ id, reason: "self" });
    else if (!u) blocked.push({ id, reason: "not_found" });
    else if (isSuperAdminUserIdAndEmail(u.id, u.email))
      blocked.push({ id, reason: "super_admin" });
    else deletable.push(u);
  }

  const deletingIds = new Set(deletable.map((u) => u.id));
  const touchedVendorIds = new Set(deletable.map((u) => u.vendor_id));
  const orgsToDelete: DeleteVendorInfo[] = [];
  const orgsLosingAdmin: DeleteVendorInfo[] = [];

  for (const v of input.vendors) {
    if (!touchedVendorIds.has(v.id)) continue;
    const remaining = v.members.filter((m) => !deletingIds.has(m.id));
    if (remaining.length === 0) {
      orgsToDelete.push(v);
      continue;
    }
    const hadAdminRemoved = v.members.some(
      (m) => deletingIds.has(m.id) && m.org_role === "admin"
    );
    const hasAdminLeft = remaining.some((m) => m.org_role === "admin");
    if (hadAdminRemoved && !hasAdminLeft) orgsLosingAdmin.push(v);
  }

  return { deletable, blocked, orgsToDelete, orgsLosingAdmin };
}

/** True when the ids are the same set, ignoring order. */
export function sameIdSet(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((x) => set.has(x));
}
