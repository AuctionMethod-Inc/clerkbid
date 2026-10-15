"use client";

import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Pencil, Trash2 } from "lucide-react";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useCurrentEvent } from "@/lib/hooks/useCurrentEvent";
import { useToast } from "@/components/providers/ToastProvider";
import { liveQueryGuard } from "@/lib/dexie/liveQueryGuard";
import { downloadCsv } from "@/lib/services/csvExporter";
import {
  filterMasterBidders,
  filterMasterConsignors,
  inCurrentEventOnly,
  searchMasterBidders,
  searchMasterConsignors,
  type DirectoryBidderFilter,
  type DirectoryConsignorFilter,
} from "@/lib/directory/search";
import { MasterBidderForm } from "@/components/directory/MasterBidderForm";
import { MasterConsignorForm } from "@/components/directory/MasterConsignorForm";
import { ResaleFlag } from "@/components/invoices/ResaleFlag";
import type { MasterBidder, MasterConsignor } from "@/lib/db";
import {
  cleanupDirectoryDuplicates,
  publishDirectoryChanges,
} from "@/lib/directory/sync";
import {
  deleteMasterBidders,
  deleteMasterConsignors,
} from "@/lib/directory/upsert";
import { ensureSettingsRow } from "@/lib/settings";

type Tab = "bidders" | "consignors";

export default function DirectoryPage() {
  const { db, ready } = useUserDb();
  const { currentEventId, currentEvent } = useCurrentEvent();
  const { showToast } = useToast();
  const [tab, setTab] = useState<Tab>("bidders");
  const [search, setSearch] = useState("");
  const [bidderFilter, setBidderFilter] = useState<DirectoryBidderFilter>("all");
  const [consignorFilter, setConsignorFilter] =
    useState<DirectoryConsignorFilter>("all");
  const [inEventOnly, setInEventOnly] = useState(false);
  const [bidderFormOpen, setBidderFormOpen] = useState(false);
  const [editingBidder, setEditingBidder] = useState<MasterBidder | null>(null);
  const [consignorFormOpen, setConsignorFormOpen] = useState(false);
  const [editingConsignor, setEditingConsignor] =
    useState<MasterConsignor | null>(null);
  const [selectedBidderKeys, setSelectedBidderKeys] = useState<Set<string>>(
    () => new Set()
  );
  const [selectedConsignorKeys, setSelectedConsignorKeys] = useState<
    Set<string>
  >(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<{
    kind: Tab;
    syncKeys: string[];
  } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!ready || !db) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await cleanupDirectoryDuplicates(db);
        if (cancelled) return;
        if (result.conflict) {
          showToast({
            kind: "info",
            message:
              "Another device updated Directory; local Directory was refreshed from the cloud.",
          });
          return;
        }
        if (result.biddersRemoved === 0 && result.consignorsRemoved === 0) {
          return;
        }
        const parts: string[] = [];
        if (result.biddersRemoved > 0) {
          parts.push(
            `${result.biddersRemoved} duplicate bidder${
              result.biddersRemoved === 1 ? "" : "s"
            }`
          );
        }
        if (result.consignorsRemoved > 0) {
          parts.push(
            `${result.consignorsRemoved} duplicate consignor${
              result.consignorsRemoved === 1 ? "" : "s"
            }`
          );
        }
        showToast({
          kind: "success",
          message: `Removed ${parts.join(" and ")} from Directory.`,
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, db, showToast]);

  const directoryDirty = useLiveQuery(
    async () =>
      liveQueryGuard(
        "directory.dirty",
        async () => {
          if (!ready || !db) return false;
          await ensureSettingsRow(db);
          const s = await db.settings.get(1);
          return Boolean(s?.directoryDirty);
        },
        false
      ),
    [ready, db]
  );

  const masters = useLiveQuery(
    async () =>
      liveQueryGuard(
        "directory.masters",
        async () => {
          if (!ready || !db) {
            return { bidders: [] as MasterBidder[], consignors: [] as MasterConsignor[] };
          }
          const [bidders, consignors] = await Promise.all([
            db.masterBidders.toArray(),
            db.masterConsignors.toArray(),
          ]);
          bidders.sort((a, b) =>
            `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`)
          );
          consignors.sort((a, b) => a.name.localeCompare(b.name));
          return { bidders, consignors };
        },
        { bidders: [], consignors: [] }
      ),
    [ready, db]
  );

  const eventLinks = useLiveQuery(
    async () =>
      liveQueryGuard(
        "directory.eventLinks",
        async () => {
          if (!ready || !db || currentEventId == null) {
            return { bidderKeys: [] as string[], consignorKeys: [] as string[] };
          }
          const [bidders, consignors] = await Promise.all([
            db.bidders.where("eventId").equals(currentEventId).toArray(),
            db.consignors.where("eventId").equals(currentEventId).toArray(),
          ]);
          return {
            bidderKeys: bidders
              .map((b) => b.masterSyncKey)
              .filter((k): k is string => Boolean(k)),
            consignorKeys: consignors
              .map((c) => c.masterSyncKey)
              .filter((k): k is string => Boolean(k)),
          };
        },
        { bidderKeys: [], consignorKeys: [] }
      ),
    [ready, db, currentEventId]
  );

  const bidderKeys = useMemo(
    () => new Set(eventLinks?.bidderKeys ?? []),
    [eventLinks]
  );
  const consignorKeys = useMemo(
    () => new Set(eventLinks?.consignorKeys ?? []),
    [eventLinks]
  );

  const bidderRows = useMemo(() => {
    let rows = searchMasterBidders(masters?.bidders ?? [], search);
    rows = filterMasterBidders(rows, bidderFilter);
    rows = inCurrentEventOnly(rows, bidderKeys, inEventOnly);
    return rows;
  }, [masters, search, bidderFilter, inEventOnly, bidderKeys]);

  const consignorRows = useMemo(() => {
    let rows = searchMasterConsignors(masters?.consignors ?? [], search);
    rows = filterMasterConsignors(rows, consignorFilter);
    rows = inCurrentEventOnly(rows, consignorKeys, inEventOnly);
    return rows;
  }, [masters, search, consignorFilter, inEventOnly, consignorKeys]);

  const visibleBidderKeySet = useMemo(
    () => new Set(bidderRows.map((b) => b.syncKey)),
    [bidderRows]
  );
  const visibleConsignorKeySet = useMemo(
    () => new Set(consignorRows.map((c) => c.syncKey)),
    [consignorRows]
  );

  const allVisibleBiddersSelected =
    bidderRows.length > 0 &&
    bidderRows.every((b) => selectedBidderKeys.has(b.syncKey));
  const allVisibleConsignorsSelected =
    consignorRows.length > 0 &&
    consignorRows.every((c) => selectedConsignorKeys.has(c.syncKey));

  const selectedCount =
    tab === "bidders" ? selectedBidderKeys.size : selectedConsignorKeys.size;

  function switchTab(next: Tab) {
    setTab(next);
    setSearch("");
    setSelectedBidderKeys(new Set());
    setSelectedConsignorKeys(new Set());
  }

  function toggleBidder(syncKey: string) {
    setSelectedBidderKeys((prev) => {
      const next = new Set(prev);
      if (next.has(syncKey)) next.delete(syncKey);
      else next.add(syncKey);
      return next;
    });
  }

  function toggleConsignor(syncKey: string) {
    setSelectedConsignorKeys((prev) => {
      const next = new Set(prev);
      if (next.has(syncKey)) next.delete(syncKey);
      else next.add(syncKey);
      return next;
    });
  }

  function toggleSelectAllVisibleBidders() {
    setSelectedBidderKeys((prev) => {
      if (allVisibleBiddersSelected) {
        const next = new Set(prev);
        visibleBidderKeySet.forEach((key) => next.delete(key));
        return next;
      }
      const next = new Set(prev);
      visibleBidderKeySet.forEach((key) => next.add(key));
      return next;
    });
  }

  function toggleSelectAllVisibleConsignors() {
    setSelectedConsignorKeys((prev) => {
      if (allVisibleConsignorsSelected) {
        const next = new Set(prev);
        visibleConsignorKeySet.forEach((key) => next.delete(key));
        return next;
      }
      const next = new Set(prev);
      visibleConsignorKeySet.forEach((key) => next.add(key));
      return next;
    });
  }

  async function confirmDelete() {
    if (!db || !pendingDelete || pendingDelete.syncKeys.length === 0) return;
    setDeleting(true);
    try {
      const keys = pendingDelete.syncKeys;
      if (pendingDelete.kind === "bidders") {
        const n = await deleteMasterBidders(db, keys);
        setSelectedBidderKeys((prev) => {
          const next = new Set(prev);
          keys.forEach((k) => next.delete(k));
          return next;
        });
        const pub = await publishDirectoryChanges(db);
        if (pub.conflictReplaced) {
          showToast({
            kind: "info",
            message:
              "Another device updated Directory; your unsynced local Directory changes were replaced from the cloud.",
          });
        } else if (!pub.ok) {
          showToast({
            kind: "error",
            message:
              "Deleted locally, but could not sync Directory. Stay online and open Directory again.",
          });
        } else {
          showToast({
            kind: "success",
            message:
              n === 1
                ? "Deleted 1 bidder from Directory."
                : `Deleted ${n} bidders from Directory.`,
          });
        }
      } else {
        const n = await deleteMasterConsignors(db, keys);
        setSelectedConsignorKeys((prev) => {
          const next = new Set(prev);
          keys.forEach((k) => next.delete(k));
          return next;
        });
        const pub = await publishDirectoryChanges(db);
        if (pub.conflictReplaced) {
          showToast({
            kind: "info",
            message:
              "Another device updated Directory; your unsynced local Directory changes were replaced from the cloud.",
          });
        } else if (!pub.ok) {
          showToast({
            kind: "error",
            message:
              "Deleted locally, but could not sync Directory. Stay online and open Directory again.",
          });
        } else {
          showToast({
            kind: "success",
            message:
              n === 1
                ? "Deleted 1 consignor from Directory."
                : `Deleted ${n} consignors from Directory.`,
          });
        }
      }
      setPendingDelete(null);
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not delete.",
      });
    } finally {
      setDeleting(false);
    }
  }

  function exportBidders() {
    downloadCsv(
      "clerkbid-master-bidders.csv",
      [
        "firstName",
        "lastName",
        "email",
        "phone",
        "mailingAddress",
        "resaleNumber",
      ],
      bidderRows.map((b) => [
        b.firstName,
        b.lastName,
        b.email ?? "",
        b.phone ?? "",
        b.mailingAddress ?? "",
        b.resaleNumber ?? "",
      ])
    );
  }

  function exportConsignors() {
    downloadCsv(
      "clerkbid-master-consignors.csv",
      ["name", "email", "phone", "mailingAddress", "notes", "commission"],
      consignorRows.map((c) => [
        c.name,
        c.email ?? "",
        c.phone ?? "",
        c.mailingAddress ?? "",
        c.notes ?? "",
        c.commissionRate != null
          ? String(Math.round(c.commissionRate * 10000) / 100)
          : "",
      ])
    );
  }

  const deleteMessage =
    pendingDelete == null
      ? ""
      : pendingDelete.kind === "bidders"
        ? pendingDelete.syncKeys.length === 1
          ? "Remove this bidder from the Directory? Event registrations are kept; only the master Directory entry is deleted."
          : `Remove ${pendingDelete.syncKeys.length} bidders from the Directory? Event registrations are kept; only master Directory entries are deleted.`
        : pendingDelete.syncKeys.length === 1
          ? "Remove this consignor from the Directory? Event consignors are kept; only the master Directory entry is deleted."
          : `Remove ${pendingDelete.syncKeys.length} consignors from the Directory? Event consignors are kept; only master Directory entries are deleted.`;

  return (
    <div>
      <Header
        title="Directory"
        description={
          directoryDirty
            ? "Master bidders and consignors across all events. Directory changes are waiting to sync to the cloud."
            : "Master bidders and consignors across all events. Lookup from an event to assign a paddle or consignor number."
        }
        actions={
          tab === "bidders" ? (
            <>
              {selectedBidderKeys.size > 0 ? (
                <Button
                  variant="danger"
                  type="button"
                  onClick={() =>
                    setPendingDelete({
                      kind: "bidders",
                      syncKeys: Array.from(selectedBidderKeys),
                    })
                  }
                >
                  Delete selected ({selectedBidderKeys.size})
                </Button>
              ) : null}
              <Button variant="secondary" type="button" onClick={exportBidders}>
                Export CSV
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setEditingBidder(null);
                  setBidderFormOpen(true);
                }}
              >
                Add bidder
              </Button>
            </>
          ) : (
            <>
              {selectedConsignorKeys.size > 0 ? (
                <Button
                  variant="danger"
                  type="button"
                  onClick={() =>
                    setPendingDelete({
                      kind: "consignors",
                      syncKeys: Array.from(selectedConsignorKeys),
                    })
                  }
                >
                  Delete selected ({selectedConsignorKeys.size})
                </Button>
              ) : null}
              <Button variant="secondary" type="button" onClick={exportConsignors}>
                Export CSV
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setEditingConsignor(null);
                  setConsignorFormOpen(true);
                }}
              >
                Add consignor
              </Button>
            </>
          )
        }
      />

      <div className="mb-4 flex flex-wrap gap-2">
        <Button
          variant={tab === "bidders" ? "primary" : "secondary"}
          type="button"
          onClick={() => switchTab("bidders")}
        >
          Bidders
        </Button>
        <Button
          variant={tab === "consignors" ? "primary" : "secondary"}
          type="button"
          onClick={() => switchTab("consignors")}
        >
          Consignors
        </Button>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 max-w-md">
          <label htmlFor="directory-search" className="sr-only">
            Search directory
          </label>
          <input
            id="directory-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name, email, or last 4 of phone"
            className="w-full rounded-lg border border-navy/15 bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-navy dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          />
        </div>
        {tab === "bidders" ? (
          <select
            aria-label="Filter bidders"
            className="rounded-lg border border-navy/15 bg-surface px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            value={bidderFilter}
            onChange={(e) =>
              setBidderFilter(e.target.value as DirectoryBidderFilter)
            }
          >
            <option value="all">All</option>
            <option value="hasResale">Has resale number</option>
            <option value="hasEmail">Has email</option>
          </select>
        ) : (
          <select
            aria-label="Filter consignors"
            className="rounded-lg border border-navy/15 bg-surface px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            value={consignorFilter}
            onChange={(e) =>
              setConsignorFilter(e.target.value as DirectoryConsignorFilter)
            }
          >
            <option value="all">All</option>
            <option value="hasEmail">Has email</option>
            <option value="hasAddress">Has address</option>
          </select>
        )}
        {currentEventId != null ? (
          <label className="flex items-center gap-2 text-sm text-ink dark:text-slate-200">
            <input
              type="checkbox"
              checked={inEventOnly}
              onChange={(e) => setInEventOnly(e.target.checked)}
            />
            On {currentEvent?.name ?? "this event"}
          </label>
        ) : null}
      </div>

      {selectedCount > 0 ? (
        <p className="mb-2 text-sm text-muted">
          {selectedCount} selected
        </p>
      ) : null}

      {tab === "bidders" ? (
        <div className="overflow-x-auto rounded-xl border border-navy/10 bg-white dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-navy/10 bg-surface dark:border-slate-700 dark:bg-slate-800/80">
              <tr>
                <th className="w-10 px-3 py-2 text-left">
                  <input
                    type="checkbox"
                    aria-label="Select all visible bidders"
                    checked={allVisibleBiddersSelected}
                    disabled={bidderRows.length === 0}
                    onChange={toggleSelectAllVisibleBidders}
                  />
                </th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Address</th>
                <th className="px-3 py-2 text-left">Resale</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy/10 dark:divide-slate-700">
              {bidderRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-muted">
                    No master bidders match.
                  </td>
                </tr>
              ) : (
                bidderRows.map((b) => (
                  <tr key={b.syncKey}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${b.firstName} ${b.lastName}`}
                        checked={selectedBidderKeys.has(b.syncKey)}
                        onChange={() => toggleBidder(b.syncKey)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      {b.lastName}, {b.firstName}
                    </td>
                    <td className="px-3 py-2 font-mono text-muted">
                      {b.phone ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">{b.email ?? "—"}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-muted" title={b.mailingAddress}>
                      {b.mailingAddress?.trim()
                        ? b.mailingAddress.trim().split(/\r?\n/)[0]
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1">
                        <ResaleFlag resaleNumber={b.resaleNumber} />
                        {b.resaleNumber?.trim() ? b.resaleNumber : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        type="button"
                        className="!p-1.5"
                        aria-label={`Edit ${b.firstName} ${b.lastName}`}
                        onClick={() => {
                          setEditingBidder(b);
                          setBidderFormOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        type="button"
                        className="!p-1.5 text-danger"
                        aria-label={`Delete ${b.firstName} ${b.lastName}`}
                        onClick={() =>
                          setPendingDelete({
                            kind: "bidders",
                            syncKeys: [b.syncKey],
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-navy/10 bg-white dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-navy/10 bg-surface dark:border-slate-700 dark:bg-slate-800/80">
              <tr>
                <th className="w-10 px-3 py-2 text-left">
                  <input
                    type="checkbox"
                    aria-label="Select all visible consignors"
                    checked={allVisibleConsignorsSelected}
                    disabled={consignorRows.length === 0}
                    onChange={toggleSelectAllVisibleConsignors}
                  />
                </th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">Address</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-navy/10 dark:divide-slate-700">
              {consignorRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-muted">
                    No master consignors match.
                  </td>
                </tr>
              ) : (
                consignorRows.map((c) => (
                  <tr key={c.syncKey}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.name}`}
                        checked={selectedConsignorKeys.has(c.syncKey)}
                        onChange={() => toggleConsignor(c.syncKey)}
                      />
                    </td>
                    <td className="px-3 py-2">{c.name}</td>
                    <td className="px-3 py-2 font-mono text-muted">
                      {c.phone ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-muted">{c.email ?? "—"}</td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-muted" title={c.mailingAddress}>
                      {c.mailingAddress?.trim()
                        ? c.mailingAddress.trim().split(/\r?\n/)[0]
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="ghost"
                        type="button"
                        className="!p-1.5"
                        aria-label={`Edit ${c.name}`}
                        onClick={() => {
                          setEditingConsignor(c);
                          setConsignorFormOpen(true);
                        }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        type="button"
                        className="!p-1.5 text-danger"
                        aria-label={`Delete ${c.name}`}
                        onClick={() =>
                          setPendingDelete({
                            kind: "consignors",
                            syncKeys: [c.syncKey],
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <MasterBidderForm
        open={bidderFormOpen}
        editing={editingBidder}
        onClose={() => {
          setBidderFormOpen(false);
          setEditingBidder(null);
        }}
        onSaved={() =>
          showToast({ kind: "success", message: "Master bidder saved." })
        }
      />
      <MasterConsignorForm
        open={consignorFormOpen}
        editing={editingConsignor}
        onClose={() => {
          setConsignorFormOpen(false);
          setEditingConsignor(null);
        }}
        onSaved={() =>
          showToast({ kind: "success", message: "Master consignor saved." })
        }
      />
      <ConfirmDialog
        open={pendingDelete != null}
        title={
          pendingDelete?.kind === "consignors"
            ? pendingDelete.syncKeys.length === 1
              ? "Delete consignor"
              : "Delete consignors"
            : pendingDelete?.syncKeys.length === 1
              ? "Delete bidder"
              : "Delete bidders"
        }
        message={deleteMessage}
        confirmLabel={deleting ? "Deleting…" : "Delete"}
        danger
        onClose={() => {
          if (!deleting) setPendingDelete(null);
        }}
        onConfirm={() => void confirmDelete()}
      />
    </div>
  );
}
