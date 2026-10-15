"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useLiveQuery } from "dexie-react-hooks";
import { Header } from "@/components/layout/Header";
import { Button } from "@/components/ui/Button";
import { InvoiceTable, type InvoiceWithBidder } from "@/components/invoices/InvoiceTable";
import { InvoiceDetailModal } from "@/components/invoices/InvoiceDetail";
import { PaymentModal } from "@/components/invoices/PaymentModal";
import { useCurrentEvent } from "@/lib/hooks/useCurrentEvent";
import { useToast } from "@/components/providers/ToastProvider";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import {
  bidderIdsPendingFirstInvoice,
  generateAllInvoicesForEvent,
  getSalesForInvoice,
  loadInvoicePdfInput,
  resolveInvoiceForOpenDetail,
  attachUnallocatedSalesToUnpaidInvoice,
  upsertInvoiceForBidder,
} from "@/lib/services/invoiceLogic";
import {
  buildCombinedInvoicePdf,
  buildInvoicePdf,
  openPdfInNewTab,
} from "@/lib/services/invoicePdf";
import { liveQueryGuard } from "@/lib/dexie/liveQueryGuard";

const linkSecondary =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-navy/15 bg-surface px-4 py-2 text-sm font-medium text-ink transition hover:border-navy/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-navy focus-visible:ring-offset-2 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:border-slate-500 dark:focus-visible:ring-offset-slate-950";

type Filter = "all" | "unpaid" | "paid";

export default function InvoicesPage() {
  const { db, ready: dbReady } = useUserDb();
  const { currentEvent, currentEventId } = useCurrentEvent();
  const { showToast } = useToast();
  const { scheduleCloudPush } = useCloudSync();
  const [filter, setFilter] = useState<Filter>("all");
  const [detailInv, setDetailInv] = useState<InvoiceWithBidder | null>(null);
  const [payInv, setPayInv] = useState<InvoiceWithBidder | null>(null);

  const sym = currentEvent?.currencySymbol ?? "$";

  const invoiceRows = useLiveQuery(
    async () =>
      liveQueryGuard("invoices.rows", async () => {
        if (currentEventId == null || !dbReady || !db) return [];
        const invs = await db.invoices
          .where("eventId")
          .equals(currentEventId)
          .toArray();
        const bidders = await db.bidders
          .where("eventId")
          .equals(currentEventId)
          .toArray();
        const bMap = new Map(bidders.map((b) => [b.id!, b]));
        return invs
          .map((inv) => ({ ...inv, bidder: bMap.get(inv.bidderId) }))
          .sort((a, b) =>
            a.invoiceNumber.localeCompare(b.invoiceNumber, undefined, {
              numeric: true,
            })
          );
      }, []),
    [currentEventId, dbReady, db]
  );

  const filteredRows = useMemo(() => {
    if (!invoiceRows) return [];
    if (filter === "all") return invoiceRows;
    return invoiceRows.filter((i) => i.status === filter);
  }, [invoiceRows, filter]);

  const pendingBidders = useLiveQuery(
    async () =>
      liveQueryGuard("invoices.pendingBidders", async () => {
        if (currentEventId == null || !dbReady || !db) return [];
        const ids = await bidderIdsPendingFirstInvoice(db, currentEventId);
        const out = [];
        for (const id of ids) {
          const b = await db.bidders.get(id);
          if (b) out.push(b);
        }
        out.sort((a, b) => a.paddleNumber - b.paddleNumber);
        return out;
      }, []),
    [currentEventId, dbReady, db]
  );

  useEffect(() => {
    if (!db || !currentEvent || !pendingBidders?.length) return;
    let cancelled = false;
    void (async () => {
      let anyUpdated = false;
      for (const b of pendingBidders) {
        if (cancelled || b.id == null) continue;
        const r = await attachUnallocatedSalesToUnpaidInvoice(
          db,
          currentEvent,
          b.id
        );
        if (r?.kind === "updated") anyUpdated = true;
      }
      if (!cancelled && anyUpdated) scheduleCloudPush();
    })();
    return () => {
      cancelled = true;
    };
  }, [db, currentEvent, pendingBidders, scheduleCloudPush]);

  const detailInvoiceResolved = useLiveQuery(
    async () =>
      liveQueryGuard("invoices.detailResolved", async () => {
        if (
          detailInv?.id == null ||
          currentEventId == null ||
          !dbReady ||
          !db
        ) {
          return null;
        }
        return resolveInvoiceForOpenDetail(db, currentEventId, detailInv);
      }, null),
    [
      detailInv?.id,
      detailInv?.syncKey,
      detailInv?.invoiceNumber,
      detailInv?.bidderId,
      currentEventId,
      dbReady,
      db,
    ]
  );

  const effectiveInvoiceIdForSales = useMemo(() => {
    if (detailInv?.id == null) return undefined;
    if (detailInvoiceResolved === undefined) return detailInv.id;
    if (detailInvoiceResolved === null) return undefined;
    return detailInvoiceResolved.id;
  }, [detailInv?.id, detailInvoiceResolved]);

  const detailSales = useLiveQuery(
    async () =>
      liveQueryGuard("invoices.detailSales", async () => {
        if (effectiveInvoiceIdForSales == null || !db) return [];
        return getSalesForInvoice(db, effectiveInvoiceIdForSales);
      }, []),
    [effectiveInvoiceIdForSales, db]
  );

  useEffect(() => {
    if (detailInvoiceResolved === undefined || detailInvoiceResolved === null) {
      return;
    }
    setDetailInv((prev) => {
      if (!prev || prev.id === detailInvoiceResolved.id) return prev;
      return { ...prev, ...detailInvoiceResolved, bidder: prev.bidder };
    });
  }, [detailInvoiceResolved]);

  const displayDetailInvoice =
    detailInv && detailInvoiceResolved != null
      ? { ...detailInvoiceResolved, bidder: detailInv.bidder }
      : detailInv;

  async function handleGenerateAll() {
    if (currentEventId == null || !currentEvent || !db) return;
    try {
      const r = await generateAllInvoicesForEvent(db, currentEventId);
      showToast({
        kind: "success",
        message: `Invoices: ${r.created} created, ${r.updated} updated${r.skippedPaid ? `, ${r.skippedPaid} unchanged (all sales already invoiced)` : ""}.`,
      });
      if (r.created > 0 || r.updated > 0) scheduleCloudPush();
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Generation failed.",
      });
    }
  }

  async function handleCreateForBidder(bidderId: number) {
    if (!currentEvent || !db) return;
    const r = await upsertInvoiceForBidder(db, currentEvent, bidderId);
    if (r.kind === "created" || r.kind === "updated") {
      scheduleCloudPush();
      showToast({ kind: "success", message: "Invoice created." });
    } else if (r.kind === "skipped_paid") {
      showToast({
        kind: "info",
        message: "All of this bidder’s sales are already on invoices.",
      });
    } else if (r.kind === "unchanged") {
      showToast({ kind: "info", message: "Invoice is already up to date." });
    } else {
      showToast({ kind: "error", message: "No sales for this bidder." });
    }
  }

  async function handlePrint(inv: InvoiceWithBidder) {
    if (inv.id == null || !db) return;
    const input = await loadInvoicePdfInput(db, inv.id);
    if (!input) {
      showToast({ kind: "error", message: "Could not build PDF." });
      return;
    }
    const doc = buildInvoicePdf(input);
    openPdfInNewTab(doc, `invoice-${inv.invoiceNumber}.pdf`);
  }

  async function handlePrintAllUnpaid() {
    if (!invoiceRows?.length) return;
    const unpaid = invoiceRows.filter((i) => i.status === "unpaid" && i.id != null);
    if (unpaid.length === 0) {
      showToast({ kind: "info", message: "No unpaid invoices." });
      return;
    }
    if (!db) return;
    const inputs = (
      await Promise.all(unpaid.map((i) => loadInvoicePdfInput(db, i.id!)))
    ).filter((x): x is NonNullable<typeof x> => x != null);
    if (inputs.length === 0) {
      showToast({ kind: "error", message: "Could not build PDFs." });
      return;
    }
    const doc = buildCombinedInvoicePdf(inputs);
    openPdfInNewTab(doc, "invoices-unpaid.pdf");
  }

  if (currentEventId == null || !currentEvent) {
    return (
      <div>
        <Header
          title="Invoices"
          description="Select an event to work with invoices."
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
        title="Invoices"
        description={`Generate, print, and record payments for ${currentEvent.name}.`}
        actions={
          <>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handlePrintAllUnpaid()}
            >
              Print all unpaid
            </Button>
            <Button type="button" onClick={() => void handleGenerateAll()}>
              Generate all invoices
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label
          htmlFor="inv-filter"
          className="text-sm font-medium text-ink dark:text-slate-200"
        >
          Show
        </label>
        <select
          id="inv-filter"
          className="rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
        >
          <option value="all">All</option>
          <option value="unpaid">Unpaid</option>
          <option value="paid">Paid</option>
        </select>
      </div>

      {pendingBidders && pendingBidders.length > 0 ? (
        <div className="mb-8 rounded-xl border border-gold/30 bg-amber-50/40 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
          <h2 className="text-sm font-semibold text-navy dark:text-amber-100">
            Bidders with sales not yet on an invoice
          </h2>
          <ul className="mt-3 space-y-2">
            {pendingBidders.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-navy/10 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
              >
                <span>
                  <span className="font-mono font-medium">
                    Paddle #{b.paddleNumber}
                  </span>
                  <span className="ml-2 text-ink dark:text-slate-100">
                    {b.firstName} {b.lastName}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  className="text-sm"
                  onClick={() => void handleCreateForBidder(b.id!)}
                >
                  Generate invoice
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!invoiceRows ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <InvoiceTable
          rows={filteredRows}
          currencySymbol={sym}
          onRowClick={(inv) => setDetailInv(inv)}
          onPrint={(inv) => void handlePrint(inv)}
          onMarkPaid={(inv) => setPayInv(inv)}
        />
      )}

      <InvoiceDetailModal
        open={detailInv != null}
        invoice={displayDetailInvoice}
        bidder={displayDetailInvoice?.bidder}
        sales={detailSales ?? []}
        event={currentEvent}
        currencySymbol={sym}
        onClose={() => setDetailInv(null)}
        onPrint={() => displayDetailInvoice && void handlePrint(displayDetailInvoice)}
        onMarkPaid={() => {
          if (displayDetailInvoice) setPayInv(displayDetailInvoice);
        }}
        onError={(message) => showToast({ kind: "error", message })}
        onSuccess={(message) => showToast({ kind: "success", message })}
        onUnpaid={() =>
          showToast({ kind: "success", message: "Invoice marked unpaid." })
        }
      />

      <PaymentModal
        open={payInv != null}
        invoice={payInv}
        onClose={() => setPayInv(null)}
        onPaid={(inv) => {
          showToast({ kind: "success", message: "Marked as paid." });
          if (detailInv?.id === inv.id) setDetailInv(null);
          setPayInv(null);
        }}
      />
    </div>
  );
}
