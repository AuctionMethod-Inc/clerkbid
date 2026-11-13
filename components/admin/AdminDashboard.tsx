"use client";

import { useMemo, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { AdminUserRow } from "@/lib/admin/userStats";
import type { AdminUsageStats } from "@/lib/admin/usageStats";
import { AdminUsageStats as UsageStatsSection } from "@/components/admin/AdminUsageStats";
import { DeleteUsersDialog } from "@/components/admin/DeleteUsersDialog";
import { MAX_DELETE_BATCH } from "@/lib/admin/deleteUsersPlan";
import {
  DEFAULT_USER_LIST_QUERY,
  defaultSortDir,
  filterAndSortUsers,
  isDefaultQuery,
  type ActivityFilter,
  type RoleFilter,
  type UserListQuery,
  type UserSortKey,
} from "@/lib/admin/userListView";
import { formatDateOnly, formatDateTime } from "@/lib/utils/formatDate";
import { isSuperAdminUserIdAndEmail } from "@/lib/auth/superAdmin";

function SortHeader({
  label,
  sortKey,
  query,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: UserSortKey;
  query: UserListQuery;
  onSort: (key: UserSortKey) => void;
  align?: "left" | "right";
}) {
  const active = query.sortKey === sortKey;
  return (
    <th
      className={`px-4 py-3 ${align === "right" ? "text-right" : ""}`}
      aria-sort={
        active ? (query.sortDir === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 font-semibold uppercase tracking-wide hover:text-ink dark:hover:text-slate-100 ${
          active ? "text-ink dark:text-slate-100" : ""
        }`}
      >
        {label}
        <span aria-hidden className="w-3 text-[10px]">
          {active ? (query.sortDir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

const selectClass =
  "rounded-lg border border-navy/20 bg-white px-2 py-1.5 text-sm text-ink dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";

export function AdminDashboard({
  initialUsers,
  usage,
  loadError,
}: {
  initialUsers: AdminUserRow[];
  usage: AdminUsageStats;
  loadError: string | null;
}) {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(
    () => new Set()
  );
  /** Ids shown in the delete dialog; null = closed. */
  const [deleteDialogIds, setDeleteDialogIds] = useState<number[] | null>(null);
  const [userQuery, setUserQuery] = useState<UserListQuery>(
    DEFAULT_USER_LIST_QUERY
  );
  const visibleUsers = useMemo(
    () => filterAndSortUsers(initialUsers, userQuery),
    [initialUsers, userQuery]
  );

  /** You and super admins can never be deleted from here (the server enforces it too). */
  function isSelectable(u: AdminUserRow): boolean {
    if (isSuperAdminUserIdAndEmail(String(u.id), u.email)) return false;
    return !(
      Number(session?.user?.id) === u.id ||
      session?.user?.email?.toLowerCase() === u.email.toLowerCase()
    );
  }

  // Derived from the visible rows so a user hidden by a filter can never be
  // deleted by accident.
  const selectableVisible = visibleUsers.filter(isSelectable);
  const selectedVisible = selectableVisible.filter((u) => selectedIds.has(u.id));
  const allVisibleSelected =
    selectableVisible.length > 0 &&
    selectedVisible.length === selectableVisible.length;

  function toggleUser(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const u of selectableVisible) {
        if (allVisibleSelected) next.delete(u.id);
        else next.add(u.id);
      }
      return next;
    });
  }

  function sortBy(key: UserSortKey) {
    setUserQuery((q) =>
      q.sortKey === key
        ? { ...q, sortDir: q.sortDir === "asc" ? "desc" : "asc" }
        : { ...q, sortKey: key, sortDir: defaultSortDir(key) }
    );
  }

  const [announceTitle, setAnnounceTitle] = useState("");
  const [announceBody, setAnnounceBody] = useState("");
  const [announceSeverity, setAnnounceSeverity] = useState<
    "info" | "warning"
  >("info");
  const [announceSending, setAnnounceSending] = useState(false);
  const [announceError, setAnnounceError] = useState<string | null>(null);
  const [announceOk, setAnnounceOk] = useState<string | null>(null);
  const [announceDelivery, setAnnounceDelivery] = useState<
    "online_now" | "persist_cross_session"
  >("online_now");
  const [announceSaveToCenter, setAnnounceSaveToCenter] = useState(true);

  const showAdmin =
    status === "authenticated" &&
    session?.user &&
    isSuperAdminUserIdAndEmail(session.user.id, session.user.email) &&
    !session.impersonatedByUserId;

  async function signInAs(targetUserId: number) {
    setPendingId(targetUserId);
    try {
      const res = await fetch("/api/admin/impersonate/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId }),
      });
      const data = (await res.json()) as {
        impersonationToken?: string;
        error?: string;
      };
      if (!res.ok || !data.impersonationToken) {
        window.alert(data.error ?? "Could not start impersonation.");
        return;
      }
      await signIn("admin-impersonate", {
        impersonationToken: data.impersonationToken,
        redirect: true,
        callbackUrl: "/dashboard/",
      });
    } catch {
      window.alert("Something went wrong.");
    } finally {
      setPendingId(null);
    }
  }

  async function sendAnnouncement(e: FormEvent) {
    e.preventDefault();
    setAnnounceError(null);
    setAnnounceOk(null);
    const body = announceBody.trim();
    if (!body) {
      setAnnounceError("Message is required.");
      return;
    }
    setAnnounceSending(true);
    try {
      const res = await fetch("/api/admin/ably-announce/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: announceTitle.trim() || undefined,
          body,
          severity: announceSeverity,
          deliveryAudience: announceDelivery,
          recordInMessageCenter: announceSaveToCenter,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        id?: string;
        ablyPublished?: boolean;
      };
      if (!res.ok) {
        setAnnounceError(data.error ?? "Request failed.");
        return;
      }
      const ablyNote =
        data.ablyPublished === false ? " (saved; Ably not configured)" : "";
      setAnnounceOk(`Sent (id ${data.id ?? "?"})${ablyNote}`);
      setAnnounceBody("");
      setAnnounceTitle("");
    } catch {
      setAnnounceError("Something went wrong.");
    } finally {
      setAnnounceSending(false);
    }
  }

  if (status === "loading") {
    return (
      <div>
        <Header title="Admin" description="Loading…" />
        <p className="mt-4 text-sm text-muted">Loading session…</p>
      </div>
    );
  }

  if (!showAdmin) {
    return (
      <div>
        <Header title="Admin" description="Restricted." />
        <p className="mt-4 text-sm text-muted">You do not have access.</p>
      </div>
    );
  }

  return (
    <div>
      <Header
        title="Admin"
        description="Usage, user accounts and cloud-sync statistics. Counts reflect server backups only, not unsynced local data."
      />

      {loadError ? (
        <Card className="mt-6 border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-100">
          {loadError}
        </Card>
      ) : null}

      <UsageStatsSection stats={usage} />

      <Card className="mt-6 p-4">
        <h2 className="text-sm font-semibold text-ink dark:text-slate-100">
          Global in-app announcement
        </h2>
        <p className="mt-1 text-xs text-muted">
          Online users get a toast via Ably (
          <code className="rounded bg-surface-muted px-1 font-mono text-[11px]">
            clerkbid:announce
          </code>
          ) when{" "}
          <code className="rounded bg-surface-muted px-1 font-mono text-[11px]">
            ABLY_API_KEY
          </code>{" "}
          and{" "}
          <code className="rounded bg-surface-muted px-1 font-mono text-[11px]">
            NEXT_PUBLIC_ABLY_SYNC=1
          </code>{" "}
          are set. Cross-session delivery stores the message so users who sign in
          later still get a toast. Run{" "}
          <code className="rounded bg-surface-muted px-1 font-mono text-[11px]">
            db/migrate_global_announcements.sql
          </code>{" "}
          on your database for storage and the Message center.
        </p>
        <form className="mt-4 space-y-3" onSubmit={(ev) => void sendAnnouncement(ev)}>
          <Input
            id="announce-title"
            label="Title (optional)"
            value={announceTitle}
            onChange={(ev) => setAnnounceTitle(ev.target.value)}
            maxLength={120}
            placeholder="e.g. Scheduled maintenance"
            disabled={announceSending}
          />
          <div className="w-full">
            <label
              htmlFor="announce-body"
              className="mb-1 block text-sm font-medium text-ink dark:text-slate-200"
            >
              Message
            </label>
            <textarea
              id="announce-body"
              value={announceBody}
              onChange={(ev) => setAnnounceBody(ev.target.value)}
              maxLength={2000}
              rows={4}
              disabled={announceSending}
              placeholder="Shown as an in-app toast for all signed-in users."
              className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink dark:text-slate-200">
              Who receives it
            </legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-ink dark:text-slate-200">
              <input
                type="radio"
                name="announce-delivery"
                className="mt-1"
                checked={announceDelivery === "online_now"}
                disabled={announceSending}
                onChange={() => setAnnounceDelivery("online_now")}
              />
              <span>
                <span className="font-medium">Online now</span>
                <span className="mt-0.5 block text-xs text-muted">
                  Toast for users signed in at send time (Ably). Optional log in
                  Message center if checked below.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-ink dark:text-slate-200">
              <input
                type="radio"
                name="announce-delivery"
                className="mt-1"
                checked={announceDelivery === "persist_cross_session"}
                disabled={announceSending}
                onChange={() => setAnnounceDelivery("persist_cross_session")}
              />
              <span>
                <span className="font-medium">Everyone when they sign in</span>
                <span className="mt-0.5 block text-xs text-muted">
                  Stored on the server; each user gets a toast once after login,
                  including people not online when you send. Also pushed on Ably
                  for users already online.
                </span>
              </span>
            </label>
          </fieldset>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-ink dark:text-slate-200">
            <input
              type="checkbox"
              className="mt-1"
              checked={announceSaveToCenter}
              disabled={announceSending}
              onChange={(ev) => setAnnounceSaveToCenter(ev.target.checked)}
            />
            <span>
              <span className="font-medium">Save to Message center</span>
              <span className="mt-0.5 block text-xs text-muted">
                Listed under Message center in the sidebar. Uncheck to skip the
                log for this send (online-only toasts, or cross-session toasts
                that should not appear in the archive).
              </span>
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-ink dark:text-slate-200">
              <span className="text-muted">Severity</span>
              <select
                value={announceSeverity}
                onChange={(ev) =>
                  setAnnounceSeverity(
                    ev.target.value === "warning" ? "warning" : "info"
                  )
                }
                disabled={announceSending}
                className="rounded-lg border border-navy/20 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-800"
              >
                <option value="info">Info</option>
                <option value="warning">Warning</option>
              </select>
            </label>
            <Button type="submit" disabled={announceSending}>
              {announceSending ? "Sending…" : "Send announcement"}
            </Button>
          </div>
          {announceError ? (
            <p className="text-sm text-danger" role="alert">
              {announceError}
            </p>
          ) : null}
          {announceOk ? (
            <p className="text-sm text-success dark:text-emerald-400">
              {announceOk}
            </p>
          ) : null}
        </form>
      </Card>

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <Input
            id="user-search"
            label="Search users"
            type="search"
            value={userQuery.search}
            onChange={(ev) =>
              setUserQuery((q) => ({ ...q, search: ev.target.value }))
            }
            placeholder="Name, email, organization or ID"
            className="font-sans"
          />
        </div>
        <label className="text-sm font-medium text-ink dark:text-slate-200">
          <span className="mb-1 block">Role</span>
          <select
            value={userQuery.role}
            onChange={(ev) =>
              setUserQuery((q) => ({
                ...q,
                role: ev.target.value as RoleFilter,
              }))
            }
            className={selectClass}
          >
            <option value="any">All roles</option>
            <option value="admin">Admin</option>
            <option value="clerk">Clerk</option>
            <option value="cashier">Cashier</option>
          </select>
        </label>
        <label className="text-sm font-medium text-ink dark:text-slate-200">
          <span className="mb-1 block">Activity</span>
          <select
            value={userQuery.activity}
            onChange={(ev) =>
              setUserQuery((q) => ({
                ...q,
                activity: ev.target.value as ActivityFilter,
              }))
            }
            className={selectClass}
          >
            <option value="any">Any</option>
            <option value="7d">Active in last 7 days</option>
            <option value="30d">Active in last 30 days</option>
            <option value="dormant">Dormant (over 30 days)</option>
            <option value="never">Never active</option>
          </select>
        </label>
        {!isDefaultQuery(userQuery) ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setUserQuery((q) => ({
                ...DEFAULT_USER_LIST_QUERY,
                sortKey: q.sortKey,
                sortDir: q.sortDir,
              }))
            }
          >
            Clear filters
          </Button>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-muted" aria-live="polite">
        Showing {visibleUsers.length} of {initialUsers.length} users
      </p>

      {selectedVisible.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 rounded-lg border border-navy/15 bg-surface-muted/60 px-4 py-2 text-sm dark:border-slate-600 dark:bg-slate-800/60">
          <span className="font-medium text-ink dark:text-slate-100">
            {selectedVisible.length} selected
          </span>
          <Button
            type="button"
            variant="danger"
            disabled={selectedVisible.length > MAX_DELETE_BATCH}
            onClick={() => setDeleteDialogIds(selectedVisible.map((u) => u.id))}
          >
            Delete selected…
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection
          </Button>
          {selectedVisible.length > MAX_DELETE_BATCH ? (
            <span className="text-xs text-danger">
              Select at most {MAX_DELETE_BATCH} users per deletion.
            </span>
          ) : null}
        </div>
      ) : null}

      <Card className="mt-2 overflow-x-auto p-0">
        <table className="w-full min-w-[1140px] text-left text-sm">
          <thead className="border-b border-navy/10 bg-surface-muted/50 text-xs text-muted dark:border-slate-700 dark:bg-slate-800/40">
            <tr>
              <th className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all shown users"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        selectedVisible.length > 0 && !allVisibleSelected;
                  }}
                  disabled={selectableVisible.length === 0}
                  onChange={toggleAllVisible}
                />
              </th>
              <SortHeader label="User" sortKey="name" query={userQuery} onSort={sortBy} />
              <SortHeader label="Organization" sortKey="organization" query={userQuery} onSort={sortBy} />
              <SortHeader label="Role" sortKey="role" query={userQuery} onSort={sortBy} />
              <SortHeader label="Joined" sortKey="joined" query={userQuery} onSort={sortBy} />
              <SortHeader label="Events" sortKey="events" query={userQuery} onSort={sortBy} align="right" />
              <SortHeader label="Lots" sortKey="lots" query={userQuery} onSort={sortBy} align="right" />
              <SortHeader label="Bidders" sortKey="bidders" query={userQuery} onSort={sortBy} align="right" />
              <SortHeader label="Sales" sortKey="sales" query={userQuery} onSort={sortBy} align="right" />
              <SortHeader label="Last sync" sortKey="lastSync" query={userQuery} onSort={sortBy} />
              <SortHeader label="Last active" sortKey="lastActivity" query={userQuery} onSort={sortBy} />
              <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wide">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-navy/10 dark:divide-slate-700">
            {visibleUsers.map((u) => {
              const isSelf =
                Number(session.user.id) === u.id ||
                session.user.email?.toLowerCase() === u.email.toLowerCase();
              const selectable = isSelectable(u);
              return (
                <tr
                  key={u.id}
                  className={
                    selectedIds.has(u.id) && selectable
                      ? "bg-sky-50 dark:bg-sky-950/30"
                      : "bg-white/40 dark:bg-slate-900/20"
                  }
                >
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select ${u.email}`}
                      checked={selectable && selectedIds.has(u.id)}
                      disabled={!selectable}
                      title={
                        selectable
                          ? undefined
                          : isSelf
                            ? "You cannot delete your own account."
                            : "Super-admin accounts cannot be deleted here."
                      }
                      onChange={() => toggleUser(u.id)}
                    />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="font-medium text-ink dark:text-slate-100">
                      {u.first_name} {u.last_name}
                    </div>
                    <div className="text-xs text-muted">{u.email}</div>
                    <div className="text-xs text-muted">ID {u.id}</div>
                  </td>
                  <td className="px-4 py-3 align-top text-muted">
                    <div className="text-ink dark:text-slate-200">{u.vendor_name}</div>
                    <div className="text-xs">{u.vendor_slug}</div>
                  </td>
                  <td className="px-4 py-3 align-top text-xs capitalize text-muted">
                    {u.org_role}
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-muted">
                    {formatDateOnly(u.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {u.synced_events}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {u.total_lots}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {u.total_bidders}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {u.total_sales}
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-muted">
                    {u.last_cloud_sync
                      ? formatDateTime(u.last_cloud_sync)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-muted">
                    {u.last_activity_at
                      ? formatDateTime(u.last_activity_at)
                      : "—"}
                  </td>
                  <td className="px-4 py-3 align-top">
                    {isSelf ? (
                      <span className="text-xs text-muted">You</span>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={pendingId != null}
                          onClick={() => void signInAs(u.id)}
                        >
                          {pendingId === u.id ? "Signing in…" : "Sign in as"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={pendingId != null || !selectable}
                          className="border-red-200 text-red-800 hover:bg-red-50 dark:border-red-900/50 dark:text-red-200 dark:hover:bg-red-950/40"
                          onClick={() => setDeleteDialogIds([u.id])}
                          title={
                            isSuperAdminUserIdAndEmail(String(u.id), u.email)
                              ? "Super-admin accounts cannot be deleted here."
                              : undefined
                          }
                        >
                          Delete user…
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {initialUsers.length === 0 && !loadError ? (
          <p className="p-6 text-sm text-muted">No users yet.</p>
        ) : initialUsers.length > 0 && visibleUsers.length === 0 ? (
          <p className="p-6 text-sm text-muted">
            No users match these filters.
          </p>
        ) : null}
      </Card>

      <DeleteUsersDialog
        userIds={deleteDialogIds}
        onClose={() => setDeleteDialogIds(null)}
        onDeleted={async () => {
          setDeleteDialogIds(null);
          setSelectedIds(new Set());
          // Await so the server component re-renders with the new list.
          await router.refresh();
        }}
      />

      <p className="mt-6 text-xs text-muted">
        Impersonation and user deletion are audited in your server logs. Use
        only to support customers who expect you to access or manage their
        account.
      </p>
    </div>
  );
}
