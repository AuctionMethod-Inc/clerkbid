import { describe, expect, it } from "vitest";
import type { AdminUserRow } from "@/lib/admin/userStats";
import {
  DEFAULT_USER_LIST_QUERY,
  defaultSortDir,
  filterAndSortUsers,
  filterUsers,
  matchesActivity,
  sortUsers,
  type UserListQuery,
} from "./userListView";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

function user(over: Partial<AdminUserRow> & { id: number }): AdminUserRow {
  return {
    email: `u${over.id}@example.com`,
    first_name: "First",
    last_name: "Last",
    created_at: daysAgo(100),
    vendor_id: over.id,
    vendor_name: `Org ${over.id}`,
    vendor_slug: `org-${over.id}`,
    synced_events: 0,
    total_lots: "0",
    total_bidders: "0",
    total_consignors: "0",
    total_sales: "0",
    total_invoices: "0",
    last_cloud_sync: null,
    org_role: "admin",
    last_activity_at: null,
    ...over,
  };
}

const q = (over: Partial<UserListQuery>): UserListQuery => ({
  ...DEFAULT_USER_LIST_QUERY,
  ...over,
});

const ids = (rows: AdminUserRow[]) => rows.map((r) => r.id);

describe("matchesActivity", () => {
  it("buckets by age of last activity", () => {
    expect(matchesActivity(daysAgo(3), "7d", NOW)).toBe(true);
    expect(matchesActivity(daysAgo(10), "7d", NOW)).toBe(false);
    expect(matchesActivity(daysAgo(10), "30d", NOW)).toBe(true);
    expect(matchesActivity(daysAgo(45), "30d", NOW)).toBe(false);
    expect(matchesActivity(daysAgo(45), "dormant", NOW)).toBe(true);
    expect(matchesActivity(daysAgo(5), "dormant", NOW)).toBe(false);
  });

  it("treats missing or invalid dates as never active", () => {
    expect(matchesActivity(null, "never", NOW)).toBe(true);
    expect(matchesActivity("not a date", "never", NOW)).toBe(true);
    expect(matchesActivity(null, "dormant", NOW)).toBe(false);
    expect(matchesActivity(null, "7d", NOW)).toBe(false);
    expect(matchesActivity(daysAgo(1), "never", NOW)).toBe(false);
  });

  it("accepts ISO strings (JSON-serialised dates)", () => {
    expect(matchesActivity(daysAgo(2).toISOString(), "7d", NOW)).toBe(true);
  });

  it("any matches everything", () => {
    expect(matchesActivity(null, "any", NOW)).toBe(true);
  });
});

describe("filterUsers", () => {
  const users = [
    user({ id: 1, first_name: "Ada", last_name: "Lovelace", vendor_name: "Analytical Auctions" }),
    user({ id: 2, first_name: "Grace", last_name: "Hopper", email: "grace@navy.mil", org_role: "clerk" }),
    user({ id: 3, first_name: "Linus", last_name: "T", vendor_name: "Kernel Sales", org_role: "cashier" }),
  ];

  it("searches name, email, organization and id case-insensitively", () => {
    expect(ids(filterUsers(users, q({ search: "LOVELACE" }), NOW))).toEqual([1]);
    expect(ids(filterUsers(users, q({ search: "navy.mil" }), NOW))).toEqual([2]);
    expect(ids(filterUsers(users, q({ search: "kernel" }), NOW))).toEqual([3]);
    expect(ids(filterUsers(users, q({ search: "3" }), NOW))).toEqual([3]);
  });

  it("requires every search term to match, in any order", () => {
    expect(ids(filterUsers(users, q({ search: "grace hopper" }), NOW))).toEqual([2]);
    expect(ids(filterUsers(users, q({ search: "hopper grace" }), NOW))).toEqual([2]);
    expect(ids(filterUsers(users, q({ search: "grace lovelace" }), NOW))).toEqual([]);
  });

  it("ignores surrounding whitespace in the search box", () => {
    expect(ids(filterUsers(users, q({ search: "  ada  " }), NOW))).toEqual([1]);
    expect(filterUsers(users, q({ search: "   " }), NOW)).toHaveLength(3);
  });

  it("filters by role", () => {
    expect(ids(filterUsers(users, q({ role: "clerk" }), NOW))).toEqual([2]);
    expect(ids(filterUsers(users, q({ role: "admin" }), NOW))).toEqual([1]);
  });

  it("combines filters with AND", () => {
    const rows = [
      user({ id: 1, org_role: "clerk", last_activity_at: daysAgo(2) }),
      user({ id: 2, org_role: "clerk", last_activity_at: daysAgo(60) }),
      user({ id: 3, org_role: "admin", last_activity_at: daysAgo(2) }),
    ];
    expect(ids(filterUsers(rows, q({ role: "clerk", activity: "7d" }), NOW))).toEqual([1]);
    expect(ids(filterUsers(rows, q({ role: "clerk", activity: "dormant" }), NOW))).toEqual([2]);
  });
});

describe("sortUsers", () => {
  it("sorts numeric string columns numerically, not lexically", () => {
    const rows = [
      user({ id: 1, total_lots: "9" }),
      user({ id: 2, total_lots: "100" }),
      user({ id: 3, total_lots: "25" }),
    ];
    expect(ids(sortUsers(rows, "lots", "desc"))).toEqual([2, 3, 1]);
    expect(ids(sortUsers(rows, "lots", "asc"))).toEqual([1, 3, 2]);
  });

  it("sorts names case-insensitively", () => {
    const rows = [
      user({ id: 1, first_name: "bob", last_name: "x" }),
      user({ id: 2, first_name: "Alice", last_name: "y" }),
      user({ id: 3, first_name: "Carol", last_name: "z" }),
    ];
    expect(ids(sortUsers(rows, "name", "asc"))).toEqual([2, 1, 3]);
  });

  it("puts missing dates last in both directions", () => {
    const rows = [
      user({ id: 1, last_activity_at: null }),
      user({ id: 2, last_activity_at: daysAgo(10) }),
      user({ id: 3, last_activity_at: daysAgo(1) }),
    ];
    expect(ids(sortUsers(rows, "lastActivity", "desc"))).toEqual([3, 2, 1]);
    expect(ids(sortUsers(rows, "lastActivity", "asc"))).toEqual([2, 3, 1]);
  });

  it("breaks ties by user id regardless of direction", () => {
    const rows = [user({ id: 5 }), user({ id: 2 }), user({ id: 9 })];
    expect(ids(sortUsers(rows, "events", "desc"))).toEqual([2, 5, 9]);
    expect(ids(sortUsers(rows, "events", "asc"))).toEqual([2, 5, 9]);
  });

  it("does not mutate its input", () => {
    const rows = [user({ id: 2 }), user({ id: 1 })];
    sortUsers(rows, "name", "asc");
    expect(ids(rows)).toEqual([2, 1]);
  });
});

describe("filterAndSortUsers", () => {
  it("filters then sorts", () => {
    const rows = [
      user({ id: 1, org_role: "clerk", synced_events: 1 }),
      user({ id: 2, org_role: "admin", synced_events: 50 }),
      user({ id: 3, org_role: "clerk", synced_events: 7 }),
    ];
    expect(
      ids(filterAndSortUsers(rows, q({ role: "clerk", sortKey: "events", sortDir: "desc" }), NOW))
    ).toEqual([3, 1]);
  });
});

describe("defaultSortDir", () => {
  it("starts text columns ascending and metrics descending", () => {
    expect(defaultSortDir("name")).toBe("asc");
    expect(defaultSortDir("organization")).toBe("asc");
    expect(defaultSortDir("lots")).toBe("desc");
    expect(defaultSortDir("lastActivity")).toBe("desc");
    expect(defaultSortDir("joined")).toBe("desc");
  });
});
