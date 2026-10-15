"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ConsignorForm } from "@/components/consignors/ConsignorForm";
import { ConsignorTable } from "@/components/consignors/ConsignorTable";
import { useCurrentEvent } from "@/lib/hooks/useCurrentEvent";
import {
  countSalesForConsignor,
  useConsignorsForEvent,
} from "@/lib/hooks/useConsignors";
import { useToast } from "@/components/providers/ToastProvider";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { downloadCsv } from "@/lib/services/csvExporter";
import { parseConsignorCsv } from "@/lib/services/csvImportConsignors";
import {
  buildConsignorStatementPdf,
  openConsignorStatementPdf,
} from "@/lib/services/consignorStatementPdf";
import type { Consignor } from "@/lib/db";
import {
  mutateWithEventTables,
  mutateWithParentEventTouch,
} from "@/lib/db/mutateWithParentEventTouch";
import { flushSingleEventToCloudSnapshot } from "@/lib/services/cloudSync";
import { findOrCreateMasterConsignor } from "@/lib/directory/upsert";
import { publishDirectoryChanges } from "@/lib/directory/sync";

const linkSecondary =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-navy/15 bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-navy/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-slate-500 dark:focus-visible:ring-offset-slate-950";

export default function ConsignorsPage() {
  const { db } = useUserDb();
  const { scheduleCloudPush } = useCloudSync();
  const { currentEvent, currentEventId } = useCurrentEvent();
  const { showToast } = useToast();
  const csvRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Consignor | null>(null);
  const [startWithLookup, setStartWithLookup] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Consignor | null>(null);

  const rows = useConsignorsForEvent(currentEventId ?? undefined);
  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((c) => {
      const num = String(c.consignorNumber);
      const blob = `${c.name} ${c.email ?? ""} ${c.phone ?? ""} ${c.mailingAddress ?? ""}`.toLowerCase();
      return num.includes(q) || blob.includes(q);
    });
  }, [rows, search]);

  const defaultCommissionPct =
    ((currentEvent?.defaultConsignorCommissionRate ?? 0) * 100);

  if (currentEventId == null || !currentEvent) {
    return (
      <div>
        <Header
          title="Consignors"
          description="Select an event in the sidebar to manage consignors."
          actions={
            <Link href="/events/" className={linkSecondary}>
              Events
            </Link>
          }
        />
        <p className="text-sm text-muted">No event selected.</p>
      </div>
    );
  }

  async function openStatement(c: Consignor) {
    if (!db || c.id == null || currentEventId == null || !currentEvent) return;
    const evId = currentEventId;
    const [lots, sales, allConsignors] = await Promise.all([
      db.lots.where("eventId").equals(evId).toArray(),
      db.sales.where("eventId").equals(evId).toArray(),
      db.consignors.where("eventId").equals(evId).toArray(),
    ]);
    const doc = buildConsignorStatementPdf(
      currentEvent,
      c,
      lots,
      sales,
      allConsignors
    );
    openConsignorStatementPdf(doc);
  }

  return (
    <div>
      <Header
        title="Consignors"
        description={`Register consignors, set numbers and optional commission overrides for ${currentEvent.name}. Default commission is set in event settings.`}
        actions={
          <>
            <input
              ref={csvRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              aria-hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file || !db || currentEventId == null) return;
                try {
                  const text = await file.text();
                  const { rows: parsed, issues } = parseConsignorCsv(text);
                  const existing = await db.consignors
                    .where("eventId")
                    .equals(currentEventId)
                    .toArray();
                  const taken = new Set(existing.map((c) => c.consignorNumber));
                  const conflicts: string[] = [];
                  const toAdd = parsed.filter((r) => {
                    if (taken.has(r.consignorNumber)) {
                      conflicts.push(String(r.consignorNumber));
                      return false;
                    }
                    taken.add(r.consignorNumber);
                    return true;
                  });
                  const now = new Date();
                  // Include masterConsignors: findOrCreateMasterConsignor writes that store
                  // inside this transaction (events + consignors alone causes IDB objectStore error).
                  await mutateWithEventTables(
                    db,
                    currentEventId,
                    [db.consignors, db.masterConsignors],
                    async () => {
                      for (const r of toAdd) {
                        const row: Consignor = {
                          eventId: currentEventId,
                          consignorNumber: r.consignorNumber,
                          name: r.name,
                          email: r.email,
                          phone: r.phone,
                          mailingAddress: r.mailingAddress,
                          notes: r.notes,
                          createdAt: now,
                          updatedAt: now,
                        };
                        if (r.commissionPct != null) {
                          row.commissionRate = r.commissionPct / 100;
                        }
                        const master = await findOrCreateMasterConsignor(db, {
                          name: row.name,
                          email: row.email,
                          phone: row.phone,
                          mailingAddress: row.mailingAddress,
                          notes: row.notes,
                          commissionRate: row.commissionRate,
                        }, now);
                        row.masterSyncKey = master.syncKey;
                        await db.consignors.add(row);
                      }
                    }
                  );
                  const parts: string[] = [];
                  if (toAdd.length) parts.push(`Imported ${toAdd.length} consignor(s).`);
                  if (issues.length)
                    parts.push(`${issues.length} row issue(s) in file.`);
                  if (conflicts.length)
                    parts.push(
                      `Skipped ${conflicts.length} consignor number(s) already in this event.`
                    );
                  const ok =
                    toAdd.length > 0 &&
                    issues.length === 0 &&
                    conflicts.length === 0;
                  showToast({
                    kind: ok ? "success" : toAdd.length > 0 ? "info" : "error",
                    message: parts.join(" ") || "Nothing imported.",
                  });
                  if (toAdd.length > 0) {
                    scheduleCloudPush();
                      try {
                        await publishDirectoryChanges(db);
                      } catch {
                        /* background */
                      }
                  }
                } catch (err) {
                  showToast({
                    kind: "error",
                    message:
                      err instanceof Error ? err.message : "CSV import failed.",
                  });
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                downloadCsv("clerkbid-consignors-template.csv", [
                  "consignorNumber",
                  "name",
                  "email",
                  "phone",
                  "mailingAddress",
                  "notes",
                  "commission",
                ], [
                  [
                    1,
                    "Sample Consignor",
                    "a@example.com",
                    "555-0100",
                    "123 Main St\nSpringfield ST 62701",
                    "",
                    "15",
                  ],
                ])
              }
            >
              Consignor CSV template
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => csvRef.current?.click()}
            >
              Import consignors (CSV)
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditing(null);
                setStartWithLookup(true);
                setFormOpen(true);
              }}
            >
              Lookup
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEditing(null);
                setStartWithLookup(false);
                setFormOpen(true);
              }}
            >
              Add consignor
            </Button>
          </>
        }
      />

      <div className="mb-4 max-w-md">
        <label htmlFor="consignor-search" className="sr-only">
          Search consignors
        </label>
        <input
          id="consignor-search"
          type="search"
          placeholder="Search by number, name, email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-navy/15 bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-navy dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        />
      </div>

      {!rows ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <ConsignorTable
          rows={filtered}
          defaultCommissionPct={defaultCommissionPct}
          onEdit={(c) => {
            setEditing(c);
            setStartWithLookup(false);
            setFormOpen(true);
          }}
          onDelete={(c) => setDeleteTarget(c)}
          onStatement={(c) => void openStatement(c)}
        />
      )}

      <ConsignorForm
        open={formOpen}
        eventId={currentEventId}
        editing={editing}
        startWithLookup={startWithLookup}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setStartWithLookup(false);
        }}
        onSaved={() => showToast({ kind: "success", message: "Consignor saved." })}
        onSwitchToExisting={(c) => {
          setEditing(c);
          setStartWithLookup(false);
          setFormOpen(true);
          showToast({
            kind: "info",
            message: "That consignor is already on this event.",
          });
        }}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title="Delete consignor"
        message={
          deleteTarget
            ? `Remove #${deleteTarget.consignorNumber} ${deleteTarget.name}?`
            : ""
        }
        confirmLabel="Delete"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget?.id == null || !db) return;
          const id = deleteTarget.id;
          const n = await countSalesForConsignor(db, id);
          if (n > 0) {
            showToast({
              kind: "error",
              message:
                "Cannot delete a consignor linked to recorded sales (by consignor link). Remove or change those sales first.",
            });
            setDeleteTarget(null);
            return;
          }
          const evId = deleteTarget.eventId;
          setDeleteTarget(null);
          await mutateWithParentEventTouch(db, evId, "consignors", async () => {
            await db.consignors.delete(id);
          });
          if (typeof navigator !== "undefined" && navigator.onLine) {
            await flushSingleEventToCloudSnapshot(db, evId);
          }
          scheduleCloudPush();
          showToast({ kind: "success", message: "Consignor removed." });
        }}
      />
    </div>
  );
}
