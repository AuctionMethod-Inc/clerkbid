import { unstable_noStore as noStore } from "next/cache";
import { AdminDashboard } from "@/components/admin/AdminDashboard";
import { fetchAdminUserList } from "@/lib/admin/userStats";
import { fetchAdminUsageStats } from "@/lib/admin/usageStats";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  noStore();
  let loadError: string | null = null;
  let users: Awaited<ReturnType<typeof fetchAdminUserList>> = [];

  try {
    users = await fetchAdminUserList();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("event_cloud_snapshots") && msg.includes("does not exist")) {
      loadError =
        "Database is missing cloud sync tables. Run db/migrate_cloud_sync.sql in Neon, then reload.";
    } else if (
      /user_id/i.test(msg) &&
      /event_cloud_snapshots/i.test(msg) &&
      (/does not exist/i.test(msg) || /42703/i.test(msg))
    ) {
      loadError =
        "This database uses organization-scoped cloud snapshots, but the app was out of date: it queried event_cloud_snapshots.user_id (removed after migrate_multi_user_org.sql). Deploy the latest build from main; the admin list joins on vendor_id.";
    } else {
      loadError = "Could not load user list. Check database configuration.";
    }
    console.error("[admin/page]", e);
  }

  // Never throws: each section degrades on its own.
  const usage = await fetchAdminUsageStats();

  return (
    <AdminDashboard initialUsers={users} usage={usage} loadError={loadError} />
  );
}
