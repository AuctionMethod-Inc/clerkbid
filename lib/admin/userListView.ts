import type { AdminUserRow } from "@/lib/admin/userStats";

export type UserSortKey =
  | "name"
  | "organization"
  | "role"
  | "joined"
  | "events"
  | "lots"
  | "bidders"
  | "sales"
  | "lastSync"
  | "lastActivity";

export type SortDir = "asc" | "desc";

/**
 * Based on the user's own last push (op or snapshot):
 * `7d`/`30d` active within that window, `dormant` last active over 30 days
 * ago, `never` has never pushed anything.
 */
export type ActivityFilter = "any" | "7d" | "30d" | "dormant" | "never";

export type RoleFilter = "any" | "admin" | "clerk" | "cashier";

export type UserListQuery = {
  search: string;
  role: RoleFilter;
  activity: ActivityFilter;
  sortKey: UserSortKey;
  sortDir: SortDir;
};

export const DEFAULT_USER_LIST_QUERY: UserListQuery = {
  search: "",
  role: "any",
  activity: "any",
  sortKey: "joined",
  sortDir: "asc",
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toMs(d: Date | string | null | undefined): number | null {
  if (d == null) return null;
  const ms = (typeof d === "string" ? new Date(d) : d).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function num(v: string | number | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** First click on a column: names and text A→Z, everything else biggest/newest first. */
export function defaultSortDir(key: UserSortKey): SortDir {
  switch (key) {
    case "name":
    case "organization":
    case "role":
      return "asc";
    default:
      return "desc";
  }
}

export function matchesActivity(
  lastActivity: Date | string | null | undefined,
  filter: ActivityFilter,
  now: number
): boolean {
  if (filter === "any") return true;
  const ms = toMs(lastActivity);
  if (filter === "never") return ms == null;
  if (ms == null) return false;
  const age = now - ms;
  if (filter === "7d") return age <= 7 * DAY_MS;
  if (filter === "30d") return age <= 30 * DAY_MS;
  return age > 30 * DAY_MS; // dormant
}

function matchesSearch(u: AdminUserRow, needle: string): boolean {
  if (!needle) return true;
  const hay = [
    u.first_name,
    u.last_name,
    `${u.first_name} ${u.last_name}`,
    u.email,
    u.vendor_name,
    u.vendor_slug,
    String(u.id),
  ]
    .join("\n")
    .toLowerCase();
  // Every whitespace-separated term must appear somewhere.
  return needle.split(/\s+/).every((term) => hay.includes(term));
}

export function filterUsers(
  users: readonly AdminUserRow[],
  query: Pick<UserListQuery, "search" | "role" | "activity">,
  now: number = Date.now()
): AdminUserRow[] {
  const needle = query.search.trim().toLowerCase();
  return users.filter(
    (u) =>
      matchesSearch(u, needle) &&
      (query.role === "any" || u.org_role === query.role) &&
      matchesActivity(u.last_activity_at, query.activity, now)
  );
}

type SortValue = string | number | null;

function sortValue(u: AdminUserRow, key: UserSortKey): SortValue {
  switch (key) {
    case "name":
      return `${u.first_name} ${u.last_name}`.trim().toLowerCase();
    case "organization":
      return u.vendor_name.toLowerCase();
    case "role":
      return u.org_role;
    case "joined":
      return toMs(u.created_at);
    case "events":
      return num(u.synced_events);
    case "lots":
      return num(u.total_lots);
    case "bidders":
      return num(u.total_bidders);
    case "sales":
      return num(u.total_sales);
    case "lastSync":
      return toMs(u.last_cloud_sync);
    case "lastActivity":
      return toMs(u.last_activity_at);
  }
}

/** Missing values sort last in both directions; ties fall back to user id. */
export function sortUsers(
  users: readonly AdminUserRow[],
  key: UserSortKey,
  dir: SortDir
): AdminUserRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...users].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av == null && bv != null) return 1;
    if (av != null && bv == null) return -1;
    if (av != null && bv != null && av !== bv) {
      const cmp =
        typeof av === "string" && typeof bv === "string"
          ? av.localeCompare(bv)
          : (av as number) - (bv as number);
      if (cmp !== 0) return cmp * sign;
    }
    return a.id - b.id;
  });
}

export function filterAndSortUsers(
  users: readonly AdminUserRow[],
  query: UserListQuery,
  now: number = Date.now()
): AdminUserRow[] {
  return sortUsers(filterUsers(users, query, now), query.sortKey, query.sortDir);
}

export function isDefaultQuery(q: UserListQuery): boolean {
  return (
    q.search.trim() === "" && q.role === "any" && q.activity === "any"
  );
}
