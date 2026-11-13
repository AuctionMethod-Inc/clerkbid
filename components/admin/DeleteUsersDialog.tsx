"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

type Preview = {
  users: {
    id: number;
    email: string;
    name: string;
    orgRole: string;
    vendorId: number;
  }[];
  orgsToDelete: {
    id: number;
    name: string;
    slug: string;
    syncedEvents: number;
    syncOps: number;
  }[];
  orgsLosingAdmin: { id: number; name: string }[];
};

const CONFIRM_WORD = "DELETE";

export function DeleteUsersDialog({
  userIds,
  onClose,
  onDeleted,
}: {
  /** Null keeps the dialog closed. The list is snapshotted when it opens. */
  userIds: number[] | null;
  onClose: () => void;
  onDeleted: () => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const open = userIds != null;
  const idsKey = userIds?.join(",") ?? "";

  useEffect(() => {
    setPreview(null);
    setLoadError(null);
    setTyped("");
    setDeleteError(null);
    if (!idsKey) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/admin/delete-users/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userIds: idsKey.split(",").map(Number),
            dryRun: true,
          }),
          signal: ctrl.signal,
        });
        const data = (await res.json()) as Preview & { error?: string };
        if (!res.ok) {
          setLoadError(data.error ?? "Could not preview this deletion.");
          return;
        }
        setPreview(data);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setLoadError("Could not preview this deletion.");
        }
      }
    })();
    return () => ctrl.abort();
  }, [idsKey]);

  function close() {
    if (!deleting) onClose();
  }

  async function confirmDelete() {
    if (!preview) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/admin/delete-users/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIds: preview.users.map((u) => u.id),
          expectedOrgIds: preview.orgsToDelete.map((o) => o.id),
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setDeleteError(data.error ?? "Could not delete users.");
        return;
      }
      await onDeleted();
    } catch {
      setDeleteError("Something went wrong. Nothing was confirmed deleted; reload to check.");
    } finally {
      setDeleting(false);
    }
  }

  const canConfirm =
    preview != null &&
    !deleting &&
    typed.trim().toUpperCase() === CONFIRM_WORD;
  const n = preview?.users.length ?? userIds?.length ?? 0;

  return (
    <Modal
      open={open}
      onClose={close}
      title={`Delete ${n} ${n === 1 ? "user" : "users"}`}
      maxWidthClass="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!canConfirm}
            onClick={() => void confirmDelete()}
          >
            {deleting ? "Deleting…" : `Delete ${n === 1 ? "user" : `${n} users`}`}
          </Button>
        </>
      }
    >
      {loadError ? (
        <p className="text-sm text-danger" role="alert">
          {loadError}
        </p>
      ) : !preview ? (
        <p className="text-sm text-muted">Checking what this will delete…</p>
      ) : (
        <div className="space-y-4 text-sm text-ink dark:text-slate-200">
          <p className="font-medium text-danger">
            This permanently deletes these accounts and cannot be undone.
          </p>

          <ul className="max-h-40 divide-y divide-navy/10 overflow-y-auto rounded-lg border border-navy/10 dark:divide-slate-700 dark:border-slate-700">
            {preview.users.map((u) => (
              <li key={u.id} className="px-3 py-2">
                <span className="font-medium">{u.name || u.email}</span>
                <span className="ml-2 text-xs text-muted">
                  {u.email} · ID {u.id} · {u.orgRole}
                </span>
              </li>
            ))}
          </ul>

          {preview.orgsToDelete.length > 0 ? (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/50 dark:bg-red-950/30">
              <p className="font-medium text-red-900 dark:text-red-100">
                {preview.orgsToDelete.length === 1
                  ? "This organization will also be deleted"
                  : `These ${preview.orgsToDelete.length} organizations will also be deleted`}{" "}
                because it would have no members left:
              </p>
              <ul className="mt-2 space-y-1 text-red-900 dark:text-red-100">
                {preview.orgsToDelete.map((o) => (
                  <li key={o.id}>
                    <span className="font-medium">{o.name}</span>{" "}
                    <span className="text-xs">
                      ({o.slug}) — {o.syncedEvents} cloud-backed event
                      {o.syncedEvents === 1 ? "" : "s"}, {o.syncOps} synced
                      change{o.syncOps === 1 ? "" : "s"} and all invites will be
                      removed
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted">
              No organizations will be deleted; every affected organization
              keeps at least one member.
            </p>
          )}

          {preview.orgsLosingAdmin.length > 0 ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100">
              Left with no admin:{" "}
              {preview.orgsLosingAdmin.map((o) => o.name).join(", ")}. Remaining
              members will not be able to manage the organization.
            </div>
          ) : null}

          <div>
            <label
              htmlFor="delete-users-confirm"
              className="mb-1 block font-medium"
            >
              Type {CONFIRM_WORD} to confirm
            </label>
            <input
              id="delete-users-confirm"
              value={typed}
              onChange={(ev) => setTyped(ev.target.value)}
              autoComplete="off"
              disabled={deleting}
              className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-800"
            />
          </div>

          {deleteError ? (
            <p className="text-danger" role="alert">
              {deleteError}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
