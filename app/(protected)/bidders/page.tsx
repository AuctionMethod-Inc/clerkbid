"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { BidderForm } from "@/components/bidders/BidderForm";
import { BidderSearch } from "@/components/bidders/BidderSearch";
import { BidderTable } from "@/components/bidders/BidderTable";
import { useCurrentEvent } from "@/lib/hooks/useCurrentEvent";
import {
  countSalesForBidder,
  useBiddersForEvent,
  type BidderRow,
} from "@/lib/hooks/useBidders";
import { useToast } from "@/components/providers/ToastProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { downloadCsv } from "@/lib/services/csvExporter";
import { parseBidderCsv } from "@/lib/services/csvImportBidders";
import {
  mutateWithEventTables,
  mutateWithParentEventTouch,
} from "@/lib/db/mutateWithParentEventTouch";
import { flushSingleEventToCloudSnapshot } from "@/lib/services/cloudSync";
import { findOrCreateMasterBidder } from "@/lib/directory/upsert";
import { publishDirectoryChanges } from "@/lib/directory/sync";

const linkSecondary =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-navy/15 bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-navy/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-slate-500 dark:focus-visible:ring-offset-slate-950";

function matchesSearch(b: BidderRow, q: string): boolean {
  if (!q.trim()) return true;
  const s = q.trim().toLowerCase();
  const paddle = String(b.paddleNumber);
  const name = `${b.firstName} ${b.lastName}`.toLowerCase();
  return (
    paddle.includes(s) ||
    name.includes(s) ||
    (b.phone?.toLowerCase().includes(s) ?? false) ||
    (b.email?.toLowerCase().includes(s) ?? false) ||
    (b.mailingAddress?.toLowerCase().includes(s) ?? false) ||
    (b.resaleNumber?.toLowerCase().includes(s) ?? false)
  );
}

export default function BiddersPage() {
  const { db } = useUserDb();
  const { currentEvent, currentEventId } = useCurrentEvent();
  const { showToast } = useToast();
  const { scheduleCloudPush } = useCloudSync();
  const csvRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BidderRow | null>(null);
  const [startWithLookup, setStartWithLookup] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BidderRow | null>(null);

  const rows = useBiddersForEvent(currentEventId ?? undefined);
  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter((b) => matchesSearch(b, search));
  }, [rows, search]);

  const sym = currentEvent?.currencySymbol ?? "$";

  if (currentEventId == null || !currentEvent) {
    return (
      <div>
        <Header
          title="Bidders"
          description="Select an event in the sidebar to manage bidders."
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

  return (
    <div>
      <Header
        title="Bidders"
        description={`Register and manage bidders for ${currentEvent.name}.`}
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
                  const { rows, issues } = parseBidderCsv(text);
                  const existing = await db.bidders
                    .where("eventId")
                    .equals(currentEventId)
                    .toArray();
                  const taken = new Set(existing.map((b) => b.paddleNumber));
                  const conflicts: string[] = [];
                  const toAdd = rows.filter((r) => {
                    if (taken.has(r.paddleNumber)) {
                      conflicts.push(String(r.paddleNumber));
                      return false;
                    }
                    taken.add(r.paddleNumber);
                    return true;
                  });
                  const now = new Date();
                  // Include masterBidders: findOrCreateMasterBidder writes that store
                  // inside this transaction (events + bidders alone causes IDB objectStore error).
                  await mutateWithEventTables(
                    db,
                    currentEventId,
                    [db.bidders, db.masterBidders],
                    async () => {
                      for (const r of toAdd) {
                        const master = await findOrCreateMasterBidder(db, {
                          firstName: r.firstName,
                          lastName: r.lastName,
                          email: r.email,
                          phone: r.phone,
                          mailingAddress: r.mailingAddress,
                          resaleNumber: r.resaleNumber,
                        }, now);
                        await db.bidders.add({
                          eventId: currentEventId,
                          paddleNumber: r.paddleNumber,
                          firstName: r.firstName,
                          lastName: r.lastName,
                          email: r.email,
                          phone: r.phone,
                          mailingAddress: r.mailingAddress,
                          resaleNumber: r.resaleNumber,
                          masterSyncKey: master.syncKey,
                          createdAt: now,
                          updatedAt: now,
                        });
                      }
                    }
                  );
                  if (toAdd.length > 0) {
                    scheduleCloudPush();
                    try {
                      await publishDirectoryChanges(db);
                    } catch {
                      /* background */
                    }
                  }
                  const parts: string[] = [];
                  if (toAdd.length) parts.push(`Imported ${toAdd.length} bidder(s).`);
                  if (issues.length)
                    parts.push(`${issues.length} row issue(s) in file.`);
                  if (conflicts.length)
                    parts.push(
                      `Skipped ${conflicts.length} duplicate paddle(s) already in this event.`
                    );
                  const ok =
                    toAdd.length > 0 &&
                    issues.length === 0 &&
                    conflicts.length === 0;
                  showToast({
                    kind: ok ? "success" : toAdd.length > 0 ? "info" : "error",
                    message: parts.join(" ") || "Nothing imported.",
                  });
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
                downloadCsv("clerkbid-bidders-template.csv", [
                  "paddleNumber",
                  "firstName",
                  "lastName",
                  "email",
                  "phone",
                  "mailingAddress",
                  "resaleNumber",
                ], [
                  [101, "Jane", "Doe", "jane@example.com", "555-0100", "123 Main St", ""],
                ])
              }
            >
              Bidder CSV template
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => csvRef.current?.click()}
            >
              Import bidders (CSV)
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
              Register bidder
            </Button>
          </>
        }
      />

      <div className="mb-6 max-w-md">
        <BidderSearch value={search} onChange={setSearch} />
      </div>

      {!rows ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <BidderTable
          rows={filtered}
          currencySymbol={sym}
          onEdit={(b) => {
            setEditing(b);
            setStartWithLookup(false);
            setFormOpen(true);
          }}
          onDelete={(b) => setDeleteTarget(b)}
        />
      )}

      <BidderForm
        open={formOpen}
        eventId={currentEventId}
        editing={editing}
        startWithLookup={startWithLookup}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
          setStartWithLookup(false);
        }}
        onSaved={() => showToast({ kind: "success", message: "Bidder saved." })}
        onSwitchToExisting={(b) => {
          setEditing({ ...b, totalSpent: 0, itemsWon: 0 });
          setStartWithLookup(false);
          setFormOpen(true);
          showToast({
            kind: "info",
            message: "That person is already registered for this event.",
          });
        }}
      />

      <ConfirmDialog
        open={deleteTarget != null}
        title="Delete bidder"
        message={
          deleteTarget
            ? `Remove ${deleteTarget.firstName} ${deleteTarget.lastName} (paddle #${deleteTarget.paddleNumber})?`
            : ""
        }
        confirmLabel="Delete"
        danger
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget?.id == null || !db) return;
          const id = deleteTarget.id;
          const n = await countSalesForBidder(db, id);
          if (n > 0) {
            showToast({
              kind: "error",
              message: "Cannot delete a bidder with recorded sales.",
            });
            setDeleteTarget(null);
            return;
          }
          setDeleteTarget(null);
          await mutateWithParentEventTouch(
            db,
            currentEventId,
            "bidders",
            async () => {
              await db.bidders.delete(id);
            }
          );
          if (
            typeof navigator !== "undefined" &&
            navigator.onLine &&
            currentEventId != null
          ) {
            await flushSingleEventToCloudSnapshot(db, currentEventId);
          }
          scheduleCloudPush();
          showToast({ kind: "success", message: "Bidder removed." });
        }}
      />
    </div>
  );
}
