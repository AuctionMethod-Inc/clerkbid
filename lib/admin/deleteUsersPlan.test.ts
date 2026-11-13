import { describe, expect, it } from "vitest";
import {
  MAX_DELETE_BATCH,
  buildDeletePlan,
  parseUserIds,
  sameIdSet,
  type DeleteTarget,
  type DeleteVendorInfo,
} from "./deleteUsersPlan";

const ADMIN_ID = 1;

function target(id: number, vendor_id: number, org_role = "clerk", email = `u${id}@example.com`): DeleteTarget {
  return { id, email, first_name: "F", last_name: "L", vendor_id, org_role };
}

function vendor(id: number, members: [number, string][]): DeleteVendorInfo {
  return {
    id,
    name: `Org ${id}`,
    slug: `org-${id}`,
    members: members.map(([mid, org_role]) => ({ id: mid, org_role })),
    syncedEvents: 0,
    syncOps: 0,
  };
}

describe("parseUserIds", () => {
  it("accepts and de-duplicates positive integers", () => {
    expect(parseUserIds([3, 4, 3])).toEqual({ ok: true, ids: [3, 4] });
  });

  it.each([
    ["not an array", "5"],
    ["empty", []],
    ["zero", [0]],
    ["negative", [-2]],
    ["fraction", [1.5]],
    ["string id", ["7"]],
    ["null", [null]],
  ])("rejects %s", (_label, raw) => {
    expect(parseUserIds(raw).ok).toBe(false);
  });

  it("caps the batch size", () => {
    const ids = Array.from({ length: MAX_DELETE_BATCH + 1 }, (_, i) => i + 2);
    expect(parseUserIds(ids).ok).toBe(false);
    expect(parseUserIds(ids.slice(0, MAX_DELETE_BATCH)).ok).toBe(true);
  });
});

describe("buildDeletePlan", () => {
  it("blocks yourself, super admins and unknown ids", () => {
    const plan = buildDeletePlan({
      requestedIds: [1, 2, 3, 4, 99],
      adminId: 5,
      found: [
        target(1, 1, "admin", "someone@example.com"), // user id 1 is always super admin
        target(2, 2, "admin", "Killian@AuctionMethod.com"),
        target(3, 3),
        target(5, 5),
      ],
      vendors: [],
    });
    expect(plan.blocked).toEqual([
      { id: 1, reason: "super_admin" },
      { id: 2, reason: "super_admin" },
      { id: 4, reason: "not_found" },
      { id: 99, reason: "not_found" },
    ]);
    expect(plan.deletable.map((u) => u.id)).toEqual([3]);
  });

  it("blocks self even when the row exists", () => {
    const plan = buildDeletePlan({
      requestedIds: [7],
      adminId: 7,
      found: [target(7, 1)],
      vendors: [vendor(1, [[7, "admin"]])],
    });
    expect(plan.blocked).toEqual([{ id: 7, reason: "self" }]);
    expect(plan.deletable).toEqual([]);
    expect(plan.orgsToDelete).toEqual([]);
  });

  it("deletes an org only when every member is being deleted", () => {
    const vendors = [vendor(10, [[11, "admin"], [12, "clerk"]])];
    const partial = buildDeletePlan({
      requestedIds: [12],
      adminId: ADMIN_ID,
      found: [target(12, 10)],
      vendors,
    });
    expect(partial.orgsToDelete).toEqual([]);

    const all = buildDeletePlan({
      requestedIds: [11, 12],
      adminId: ADMIN_ID,
      found: [target(11, 10, "admin"), target(12, 10)],
      vendors,
    });
    expect(all.orgsToDelete.map((o) => o.id)).toEqual([10]);
    expect(all.orgsLosingAdmin).toEqual([]);
  });

  it("does not delete an org when a member outside the selection remains", () => {
    const plan = buildDeletePlan({
      requestedIds: [11],
      adminId: ADMIN_ID,
      found: [target(11, 10, "admin")],
      vendors: [vendor(10, [[11, "admin"], [13, "admin"]])],
    });
    expect(plan.orgsToDelete).toEqual([]);
    expect(plan.orgsLosingAdmin).toEqual([]);
  });

  it("flags orgs that keep members but lose their only admin", () => {
    const plan = buildDeletePlan({
      requestedIds: [11],
      adminId: ADMIN_ID,
      found: [target(11, 10, "admin")],
      vendors: [vendor(10, [[11, "admin"], [12, "clerk"]])],
    });
    expect(plan.orgsToDelete).toEqual([]);
    expect(plan.orgsLosingAdmin.map((o) => o.id)).toEqual([10]);
  });

  it("does not flag an org that never had an admin", () => {
    const plan = buildDeletePlan({
      requestedIds: [12],
      adminId: ADMIN_ID,
      found: [target(12, 10, "clerk")],
      vendors: [vendor(10, [[12, "clerk"], [13, "cashier"]])],
    });
    expect(plan.orgsLosingAdmin).toEqual([]);
  });

  it("handles several orgs in one batch", () => {
    const plan = buildDeletePlan({
      requestedIds: [11, 21],
      adminId: ADMIN_ID,
      found: [target(11, 10, "admin"), target(21, 20, "admin")],
      vendors: [
        vendor(10, [[11, "admin"]]),
        vendor(20, [[21, "admin"], [22, "clerk"]]),
      ],
    });
    expect(plan.orgsToDelete.map((o) => o.id)).toEqual([10]);
    expect(plan.orgsLosingAdmin.map((o) => o.id)).toEqual([20]);
  });
});

describe("sameIdSet", () => {
  it("compares as sets", () => {
    expect(sameIdSet([1, 2], [2, 1])).toBe(true);
    expect(sameIdSet([1, 2], [1])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
    expect(sameIdSet([1, 1], [1, 2])).toBe(false);
  });
});
