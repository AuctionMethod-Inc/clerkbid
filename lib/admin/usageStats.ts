import { sql } from "@/lib/db/postgres";

export type UsageTotals = {
  users: number;
  orgs: number;
  signups7d: number;
  signups30d: number;
};

export type UsageContent = {
  syncedEvents: number;
  lots: number;
  bidders: number;
  consignors: number;
  sales: number;
  invoices: number;
};

export type UsageActivity = {
  activeOrgs7d: number;
  activeOrgs30d: number;
  activeUsers7d: number;
  activeUsers30d: number;
};

export type DailyOps = { day: string; ops: number; orgs: number };
export type WeeklySignups = { weekStart: string; count: number };
export type RoleCount = { role: string; count: number };
export type TopOrg = {
  vendorId: number;
  name: string;
  ops30d: number;
  members: number;
};
export type OpTypeCount = { opType: string; count: number };

/**
 * Each section is null when its query failed (for example a table that has not
 * been migrated yet), so one bad query does not blank the whole dashboard.
 * Days and weeks are UTC.
 */
export type AdminUsageStats = {
  totals: UsageTotals | null;
  content: UsageContent | null;
  activity: UsageActivity | null;
  roles: RoleCount[] | null;
  signupsByWeek: WeeklySignups[] | null;
  opsByDay: DailyOps[] | null;
  topOrgs: TopOrg[] | null;
  topOpTypes: OpTypeCount[] | null;
  failedSections: string[];
};

async function section<T>(
  name: string,
  failed: string[],
  run: () => Promise<T>
): Promise<T | null> {
  try {
    return await run();
  } catch (e) {
    console.error(`[admin/usageStats] ${name}`, e);
    failed.push(name);
    return null;
  }
}

/** JSONB array length of `payload->key`, 0 when missing or not an array. */
async function fetchContent(): Promise<UsageContent> {
  const { rows } = await sql<UsageContent>`
    SELECT
      COUNT(*)::int AS "syncedEvents",
      COALESCE(SUM(CASE WHEN jsonb_typeof(payload->'lots') = 'array'
        THEN jsonb_array_length(payload->'lots') ELSE 0 END), 0)::int AS lots,
      COALESCE(SUM(CASE WHEN jsonb_typeof(payload->'bidders') = 'array'
        THEN jsonb_array_length(payload->'bidders') ELSE 0 END), 0)::int AS bidders,
      COALESCE(SUM(CASE WHEN jsonb_typeof(payload->'consignors') = 'array'
        THEN jsonb_array_length(payload->'consignors') ELSE 0 END), 0)::int AS consignors,
      COALESCE(SUM(CASE WHEN jsonb_typeof(payload->'sales') = 'array'
        THEN jsonb_array_length(payload->'sales') ELSE 0 END), 0)::int AS sales,
      COALESCE(SUM(CASE WHEN jsonb_typeof(payload->'invoices') = 'array'
        THEN jsonb_array_length(payload->'invoices') ELSE 0 END), 0)::int AS invoices
    FROM event_cloud_snapshots
  `;
  return rows[0];
}

export async function fetchAdminUsageStats(): Promise<AdminUsageStats> {
  const failed: string[] = [];

  const [
    totals,
    content,
    activity,
    roles,
    signupsByWeek,
    opsByDay,
    topOrgs,
    topOpTypes,
  ] = await Promise.all([
    section("totals", failed, async () => {
      const { rows } = await sql<UsageTotals>`
        SELECT
          (SELECT COUNT(*) FROM users)::int AS users,
          (SELECT COUNT(*) FROM vendors)::int AS orgs,
          (SELECT COUNT(*) FROM users
            WHERE created_at > NOW() - INTERVAL '7 days')::int AS "signups7d",
          (SELECT COUNT(*) FROM users
            WHERE created_at > NOW() - INTERVAL '30 days')::int AS "signups30d"
      `;
      return rows[0];
    }),

    section("content", failed, fetchContent),

    // "Active" = pushed an op or a snapshot. Both carry the acting user.
    section("activity", failed, async () => {
      const { rows } = await sql<UsageActivity>`
        WITH activity AS (
          SELECT vendor_id, actor_user_id AS user_id, created_at AS at
          FROM event_sync_ops
          WHERE created_at > NOW() - INTERVAL '30 days'
          UNION ALL
          SELECT vendor_id, last_push_user_id, updated_at
          FROM event_cloud_snapshots
          WHERE updated_at > NOW() - INTERVAL '30 days'
        )
        SELECT
          COUNT(DISTINCT vendor_id) FILTER (
            WHERE at > NOW() - INTERVAL '7 days')::int AS "activeOrgs7d",
          COUNT(DISTINCT vendor_id)::int AS "activeOrgs30d",
          COUNT(DISTINCT user_id) FILTER (
            WHERE at > NOW() - INTERVAL '7 days')::int AS "activeUsers7d",
          COUNT(DISTINCT user_id)::int AS "activeUsers30d"
        FROM activity
      `;
      return rows[0];
    }),

    section("roles", failed, async () => {
      const { rows } = await sql<RoleCount>`
        SELECT org_role AS role, COUNT(*)::int AS count
        FROM users
        GROUP BY org_role
        ORDER BY count DESC
      `;
      return rows;
    }),

    section("signupsByWeek", failed, async () => {
      const { rows } = await sql<WeeklySignups>`
        SELECT
          to_char(w, 'YYYY-MM-DD') AS "weekStart",
          COUNT(u.id)::int AS count
        FROM generate_series(
          date_trunc('week', NOW() AT TIME ZONE 'UTC') - INTERVAL '11 weeks',
          date_trunc('week', NOW() AT TIME ZONE 'UTC'),
          INTERVAL '1 week'
        ) AS w
        LEFT JOIN users u
          ON date_trunc('week', u.created_at AT TIME ZONE 'UTC') = w
        GROUP BY w
        ORDER BY w
      `;
      return rows;
    }),

    section("opsByDay", failed, async () => {
      const { rows } = await sql<DailyOps>`
        WITH per_day AS (
          SELECT
            (created_at AT TIME ZONE 'UTC')::date AS day,
            COUNT(*)::int AS ops,
            COUNT(DISTINCT vendor_id)::int AS orgs
          FROM event_sync_ops
          WHERE created_at > NOW() - INTERVAL '31 days'
          GROUP BY 1
        )
        SELECT
          to_char(d, 'YYYY-MM-DD') AS day,
          COALESCE(p.ops, 0)::int AS ops,
          COALESCE(p.orgs, 0)::int AS orgs
        FROM generate_series(
          ((NOW() AT TIME ZONE 'UTC')::date - 29)::timestamp,
          (NOW() AT TIME ZONE 'UTC')::date::timestamp,
          INTERVAL '1 day'
        ) AS d
        LEFT JOIN per_day p ON p.day = d::date
        ORDER BY d
      `;
      return rows;
    }),

    section("topOrgs", failed, async () => {
      const { rows } = await sql<TopOrg>`
        SELECT
          v.id AS "vendorId",
          v.name,
          COUNT(o.id)::int AS "ops30d",
          (SELECT COUNT(*) FROM users mu WHERE mu.vendor_id = v.id)::int AS members
        FROM vendors v
        INNER JOIN event_sync_ops o
          ON o.vendor_id = v.id AND o.created_at > NOW() - INTERVAL '30 days'
        GROUP BY v.id, v.name
        ORDER BY "ops30d" DESC, v.id ASC
        LIMIT 5
      `;
      return rows;
    }),

    section("topOpTypes", failed, async () => {
      const { rows } = await sql<OpTypeCount>`
        SELECT op_type AS "opType", COUNT(*)::int AS count
        FROM event_sync_ops
        WHERE created_at > NOW() - INTERVAL '30 days'
        GROUP BY op_type
        ORDER BY count DESC, op_type ASC
        LIMIT 8
      `;
      return rows;
    }),
  ]);

  return {
    totals,
    content,
    activity,
    roles,
    signupsByWeek,
    opsByDay,
    topOrgs,
    topOpTypes,
    failedSections: failed,
  };
}
