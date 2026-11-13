import { sql } from "@/lib/db/postgres";

export type AdminUserRow = {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  created_at: Date;
  vendor_id: number;
  vendor_name: string;
  vendor_slug: string;
  synced_events: number;
  total_lots: string;
  total_bidders: string;
  total_consignors: string;
  total_sales: string;
  total_invoices: string;
  last_cloud_sync: Date | null;
  org_role: string;
  /** The user's own last op or snapshot push; null if never (or lookup failed). */
  last_activity_at: Date | null;
};

type BaseUserRow = Omit<AdminUserRow, "last_activity_at">;

/**
 * Last time each user pushed an op or a snapshot. Kept separate from the main
 * list query so a failure here only blanks the activity column.
 */
async function fetchLastActivityByUser(): Promise<Map<number, Date>> {
  const { rows } = await sql<{ user_id: number; last_activity_at: Date }>`
    SELECT user_id, MAX(at) AS last_activity_at
    FROM (
      SELECT actor_user_id AS user_id, created_at AS at
      FROM event_sync_ops
      WHERE actor_user_id IS NOT NULL
      UNION ALL
      SELECT last_push_user_id, updated_at
      FROM event_cloud_snapshots
      WHERE last_push_user_id IS NOT NULL
    ) a
    GROUP BY user_id
  `;
  return new Map(rows.map((r) => [r.user_id, r.last_activity_at]));
}

/**
 * Aggregates from `event_cloud_snapshots` JSONB only (not local-only IndexedDB data).
 */
export async function fetchAdminUserList(): Promise<AdminUserRow[]> {
  const [base, activity] = await Promise.all([
    fetchBaseUserList(),
    fetchLastActivityByUser().catch((e: unknown) => {
      console.error("[admin/userStats] last activity", e);
      return new Map<number, Date>();
    }),
  ]);
  return base.map((u) => ({
    ...u,
    last_activity_at: activity.get(u.id) ?? null,
  }));
}

async function fetchBaseUserList(): Promise<BaseUserRow[]> {
  const { rows } = await sql<BaseUserRow>`
    SELECT
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.created_at,
      u.org_role,
      v.id AS vendor_id,
      v.name AS vendor_name,
      v.slug AS vendor_slug,
      COUNT(ecs.id)::int AS synced_events,
      COALESCE(
        SUM(
          CASE
            WHEN jsonb_typeof(ecs.payload->'lots') = 'array'
            THEN jsonb_array_length(ecs.payload->'lots')
            ELSE 0
          END
        ),
        0
      )::text AS total_lots,
      COALESCE(
        SUM(
          CASE
            WHEN jsonb_typeof(ecs.payload->'bidders') = 'array'
            THEN jsonb_array_length(ecs.payload->'bidders')
            ELSE 0
          END
        ),
        0
      )::text AS total_bidders,
      COALESCE(
        SUM(
          CASE
            WHEN jsonb_typeof(ecs.payload->'consignors') = 'array'
            THEN jsonb_array_length(ecs.payload->'consignors')
            ELSE 0
          END
        ),
        0
      )::text AS total_consignors,
      COALESCE(
        SUM(
          CASE
            WHEN jsonb_typeof(ecs.payload->'sales') = 'array'
            THEN jsonb_array_length(ecs.payload->'sales')
            ELSE 0
          END
        ),
        0
      )::text AS total_sales,
      COALESCE(
        SUM(
          CASE
            WHEN jsonb_typeof(ecs.payload->'invoices') = 'array'
            THEN jsonb_array_length(ecs.payload->'invoices')
            ELSE 0
          END
        ),
        0
      )::text AS total_invoices,
      MAX(ecs.updated_at) AS last_cloud_sync
    FROM users u
    INNER JOIN vendors v ON v.id = u.vendor_id
    LEFT JOIN event_cloud_snapshots ecs ON ecs.vendor_id = u.vendor_id
    GROUP BY
      u.id,
      u.email,
      u.first_name,
      u.last_name,
      u.created_at,
      u.org_role,
      v.id,
      v.name,
      v.slug
    ORDER BY u.id ASC
  `;
  return rows;
}
