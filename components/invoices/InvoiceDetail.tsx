"use client";

import { useCallback, useEffect, useState } from "react";
import type { AuctionEvent, Bidder, Invoice, InvoiceManualLine, Sale } from "@/lib/db";
import { saleUnitHammer } from "@/lib/services/saleLineTotals";
import {
  effectiveInvoiceBuyersPremiumRate,
  effectiveInvoiceTaxRate,
  recalculateAndPersistInvoice,
} from "@/lib/services/invoiceLogic";
import { mutateWithEventTables } from "@/lib/db/mutateWithParentEventTouch";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatCurrency } from "@/lib/utils/formatCurrency";
import { formatDateOnly, formatDateTime } from "@/lib/utils/formatDate";
import { PAYMENT_METHODS } from "@/lib/utils/constants";
import { removeSaleFromInvoice } from "@/lib/services/saleInvoiceEdits";
import { enqueueInvoicePut } from "@/lib/sync/ops/enqueueOps";
import { SaleCorrectionModal } from "@/components/invoices/SaleCorrectionModal";
import { ResaleFlag } from "@/components/invoices/ResaleFlag";

function paymentLabel(value: string | undefined): string {
  if (!value) return "—";
  return PAYMENT_METHODS.find((p) => p.value === value)?.label ?? value;
}

function buyersPremiumLineLabel(buyersPremiumRate: number): string {
  if (buyersPremiumRate <= 0) return "Buyer's premium";
  const pct = `${(buyersPremiumRate * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  return `Buyer's premium (${pct})`;
}

/** Double rAF so React can commit and the browser can paint (improves INP after clicks). */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function taxLineLabel(taxRate: number): string {
  if (taxRate <= 0) return "Tax";
  const pct = `${(taxRate * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  return `Tax (${pct})`;
}

function ratesNearlyEqual(a: number | null, b: number | null): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-9;
}

type RateDraftParse =
  | { ok: true; value: number | null }
  | { ok: false; message: string };

function parseInvoiceRateDraft(
  raw: string,
  field: "bp" | "tax"
): RateDraftParse {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) {
    return {
      ok: false,
      message:
        field === "bp"
          ? "Buyer’s premium rate must be a non-negative number (decimal, e.g. 0.10 for 10%)."
          : "Tax rate must be a non-negative number (decimal, e.g. 0.0875 for 8.75%).",
    };
  }
  const rate = n > 1 && n <= 100 ? n / 100 : n;
  return { ok: true, value: rate };
}

function newManualLine(): InvoiceManualLine {
  return {
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `ml-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    description: "",
    amount: 0,
  };
}

export function InvoiceDetailModal({
  open,
  invoice,
  bidder,
  sales,
  event,
  currencySymbol,
  onClose,
  onPrint,
  onMarkPaid,
  onUnpaid,
  onError,
  onSuccess,
}: {
  open: boolean;
  invoice: Invoice | null;
  bidder: Bidder | undefined;
  sales: Sale[];
  event: AuctionEvent;
  currencySymbol: string;
  onClose: () => void;
  onPrint: () => void;
  onMarkPaid: () => void;
  /** Called after marking paid invoice unpaid (payment cleared). */
  onUnpaid?: () => void;
  onError: (message: string) => void;
  /** Success toasts for line edits / removal */
  onSuccess?: (message: string) => void;
}) {
  const { db } = useUserDb();
  const { scheduleCloudPush } = useCloudSync();
  const [saving, setSaving] = useState(false);
  const [correctionSale, setCorrectionSale] = useState<Sale | null>(null);
  const [bpDraft, setBpDraft] = useState("");
  const [taxDraft, setTaxDraft] = useState("");

  useEffect(() => {
    if (!open) setCorrectionSale(null);
  }, [open]);

  useEffect(() => {
    if (!open || !invoice || invoice.status !== "unpaid") return;
    setBpDraft(
      invoice.buyersPremiumRate != null
        ? String(invoice.buyersPremiumRate)
        : ""
    );
    setTaxDraft(invoice.taxRate != null ? String(invoice.taxRate) : "");
  }, [
    open,
    invoice?.id,
    invoice?.buyersPremiumRate,
    invoice?.taxRate,
    invoice?.status,
  ]);

  const persistAndRecalc = useCallback(
    async (patch: Partial<Invoice>): Promise<boolean> => {
      if (invoice?.id == null || !db || invoice.status === "paid") return true;
      if (event.id == null) return true;
      setSaving(true);
      try {
        await mutateWithEventTables(db, event.id, [db.invoices], async () => {
          await db.invoices.update(invoice.id, patch);
        });
        await recalculateAndPersistInvoice(db, invoice.id, event);
        if (event.syncId) {
          await enqueueInvoicePut(db, event.syncId, invoice.id);
        }
        scheduleCloudPush();
        return true;
      } catch (e) {
        onError(e instanceof Error ? e.message : "Could not save invoice.");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [db, event, event.id, invoice?.id, invoice?.status, onError, scheduleCloudPush]
  );

  const flushRateDrafts = useCallback(async (): Promise<boolean> => {
    if (!invoice || invoice.status === "paid" || !db || event.id == null) {
      return true;
    }
    const bpRes = parseInvoiceRateDraft(bpDraft, "bp");
    if (!bpRes.ok) {
      onError(bpRes.message);
      return false;
    }
    const taxRes = parseInvoiceRateDraft(taxDraft, "tax");
    if (!taxRes.ok) {
      onError(taxRes.message);
      return false;
    }
    const patch: Partial<Invoice> = {};
    if (!ratesNearlyEqual(bpRes.value, invoice.buyersPremiumRate ?? null)) {
      patch.buyersPremiumRate = bpRes.value;
    }
    if (!ratesNearlyEqual(taxRes.value, invoice.taxRate ?? null)) {
      patch.taxRate = taxRes.value;
    }
    if (Object.keys(patch).length === 0) return true;
    return persistAndRecalc(patch);
  }, [
    invoice,
    db,
    event.id,
    bpDraft,
    taxDraft,
    persistAndRecalc,
    onError,
  ]);

  const handleClose = useCallback(async () => {
    const ok = await flushRateDrafts();
    if (!ok) return;
    onClose();
  }, [flushRateDrafts, onClose]);

  const handlePrintWithFlush = useCallback(async () => {
    const ok = await flushRateDrafts();
    if (!ok) return;
    onPrint();
  }, [flushRateDrafts, onPrint]);

  const handleMarkPaidWithFlush = useCallback(async () => {
    const ok = await flushRateDrafts();
    if (!ok) return;
    onMarkPaid();
  }, [flushRateDrafts, onMarkPaid]);

  if (!invoice) return null;

  const inv = invoice;
  const sym = currencySymbol;
  const bpEff = effectiveInvoiceBuyersPremiumRate(inv, event);
  const taxEff = effectiveInvoiceTaxRate(inv, event);
  const showBpLine =
    inv.buyersPremiumAmount !== 0 || bpEff > 0;
  const manualLines = inv.manualLines ?? [];

  async function setManualLines(next: InvoiceManualLine[]) {
    await persistAndRecalc({ manualLines: next });
  }

  async function addManualLine() {
    await setManualLines([...manualLines, newManualLine()]);
  }

  async function removeManualLine(id: string) {
    await setManualLines(manualLines.filter((m) => m.id !== id));
  }

  async function updateManualLine(
    id: string,
    field: "description" | "amount",
    value: string
  ) {
    const next = manualLines.map((m) => {
      if (m.id !== id) return m;
      if (field === "description") {
        return { ...m, description: value };
      }
      const n = Number(value);
      return { ...m, amount: Number.isFinite(n) ? n : 0 };
    });
    await setManualLines(next);
  }

  async function handleUnpay() {
    if (inv.id == null || !db || event.id == null) return;
    if (
      !window.confirm(
        "Mark this invoice unpaid and clear payment method and date? You can record payment again afterward."
      )
    ) {
      return;
    }
    setSaving(true);
    await yieldToPaint();
    try {
      const row = await db.invoices.get(inv.id);
      if (!row?.id) return;
      const next: Invoice = { ...row, status: "unpaid" };
      delete next.paymentMethod;
      delete next.paymentDate;
      await mutateWithEventTables(db, event.id, [db.invoices], async () => {
        await db.invoices.put(next);
      });
      await yieldToPaint();
      if (event.syncId) {
        await enqueueInvoicePut(db, event.syncId, inv.id);
      }
      scheduleCloudPush();
      onUnpaid?.();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not update invoice.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveSaleFromInvoice(s: Sale) {
    if (!db || inv.id == null || s.id == null) return;
    if (
      !window.confirm(
        "Remove this hammer line from the invoice? The sale stays in your event data as unallocated. Use Generate / refresh invoices for the affected bidder(s) to attach it to an open unpaid invoice again."
      )
    ) {
      return;
    }
    setSaving(true);
    await yieldToPaint();
    try {
      await removeSaleFromInvoice(db, event, s.id, inv.id);
      await yieldToPaint();
      scheduleCloudPush();
      onSuccess?.("Line removed from invoice.");
    } catch (e) {
      onError(
        e instanceof Error ? e.message : "Could not remove line from invoice."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
    <Modal
      open={open}
      title={`Invoice ${invoice.invoiceNumber}`}
      maxWidthClass="max-w-4xl"
      onClose={() => void handleClose()}
      footer={
        <>
          <Button
            variant="secondary"
            type="button"
            onClick={() => void handleClose()}
          >
            Close
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => void handlePrintWithFlush()}
          >
            Print PDF
          </Button>
          {invoice.status === "unpaid" ? (
            <Button
              type="button"
              onClick={() => void handleMarkPaidWithFlush()}
            >
              Mark as paid
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleUnpay()}
            >
              Mark as unpaid
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {saving ? (
          <p className="text-xs text-muted">Saving…</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={invoice.status === "paid" ? "success" : "warning"}>
            {invoice.status}
          </Badge>
          <span className="text-muted">
            Generated {formatDateTime(invoice.generatedAt)}
          </span>
        </div>

        {bidder ? (
          <div className="rounded-lg border border-navy/10 bg-surface/50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
            <p className="font-medium text-navy dark:text-slate-100">
              {bidder.firstName} {bidder.lastName}
            </p>
            <p className="flex items-center gap-1.5 font-mono text-muted">
              <ResaleFlag resaleNumber={bidder.resaleNumber} />
              <span>Paddle #{bidder.paddleNumber}</span>
            </p>
            {bidder.phone ? (
              <p className="text-muted">{bidder.phone}</p>
            ) : null}
            {bidder.email ? (
              <p className="text-muted">{bidder.email}</p>
            ) : null}
            {bidder.mailingAddress?.trim() ? (
              <p className="whitespace-pre-line text-muted">
                {bidder.mailingAddress.trim()}
              </p>
            ) : null}
            {bidder.resaleNumber?.trim() ? (
              <p className="text-muted">Resale #{bidder.resaleNumber.trim()}</p>
            ) : null}
          </div>
        ) : null}

        {invoice.status === "paid" ? (
          <p className="text-muted">
            Paid {invoice.paymentDate ? formatDateOnly(invoice.paymentDate) : ""}{" "}
            · {paymentLabel(invoice.paymentMethod)}
          </p>
        ) : null}

        {invoice.status === "unpaid" ? (
          <div className="rounded-lg border border-navy/15 bg-surface/40 p-3 dark:border-slate-600 dark:bg-slate-900/40">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Rates (optional overrides)
            </h3>
            <p className="mb-3 text-xs text-muted">
              Leave blank to use the event default. Use a decimal (0.10 = 10%)
              or a whole percent (10 = 10%).
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="inv-bp-rate"
                  className="mb-1 block text-xs font-medium text-ink dark:text-slate-200"
                >
                  Buyer&apos;s premium rate
                </label>
                <input
                  id="inv-bp-rate"
                  type="text"
                  inputMode="decimal"
                  className="w-full rounded-lg border border-navy/20 bg-white px-2 py-1.5 font-mono text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  placeholder={`Event: ${(event.buyersPremiumRate ?? 0).toString()}`}
                  value={bpDraft}
                  onChange={(e) => setBpDraft(e.target.value)}
                  onBlur={() => void flushRateDrafts()}
                />
              </div>
              <div>
                <label
                  htmlFor="inv-tax-rate"
                  className="mb-1 block text-xs font-medium text-ink dark:text-slate-200"
                >
                  Tax rate
                </label>
                <input
                  id="inv-tax-rate"
                  type="text"
                  inputMode="decimal"
                  className="w-full rounded-lg border border-navy/20 bg-white px-2 py-1.5 font-mono text-sm dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                  placeholder={`Event: ${event.taxRate.toString()}`}
                  value={taxDraft}
                  onChange={(e) => setTaxDraft(e.target.value)}
                  onBlur={() => void flushRateDrafts()}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-navy/10 bg-surface/30 p-3 text-xs text-muted dark:border-slate-700">
            <p>
              Rates used: buyer&apos;s premium {((bpEff) * 100).toFixed(2).replace(/\.?0+$/, "")}
              % · tax {((taxEff) * 100).toFixed(2).replace(/\.?0+$/, "")}%
              {invoice.buyersPremiumRate != null || invoice.taxRate != null
                ? " (includes invoice overrides)"
                : " (event defaults)"}
            </p>
          </div>
        )}

        {invoice.status === "unpaid" ? (
          <div className="rounded-lg border border-navy/15 bg-surface/40 p-3 dark:border-slate-600 dark:bg-slate-900/40">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                Manual lines (after buyer&apos;s premium, before tax)
              </h3>
              <Button
                type="button"
                variant="secondary"
                className="text-xs"
                onClick={() => void addManualLine()}
              >
                Add line
              </Button>
            </div>
            {manualLines.length === 0 ? (
              <p className="text-xs text-muted">
                Optional fees, unrecorded purchases (positive), or discounts
                (negative).
              </p>
            ) : (
              <ul className="space-y-2">
                {manualLines.map((m) => (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-end gap-2 rounded-md border border-navy/10 bg-white p-2 dark:border-slate-600 dark:bg-slate-800"
                  >
                    <div className="min-w-[140px] flex-1">
                      <label className="sr-only" htmlFor={`desc-${m.id}`}>
                        Description
                      </label>
                      <input
                        id={`desc-${m.id}`}
                        type="text"
                        className="w-full rounded border border-navy/15 px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
                        placeholder="Description"
                        defaultValue={m.description}
                        onBlur={(e) =>
                          void updateManualLine(m.id, "description", e.target.value)
                        }
                      />
                    </div>
                    <div className="w-28">
                      <label className="sr-only" htmlFor={`amt-${m.id}`}>
                        Amount
                      </label>
                      <input
                        id={`amt-${m.id}`}
                        type="text"
                        inputMode="decimal"
                        className="w-full rounded border border-navy/15 px-2 py-1 font-mono text-sm dark:border-slate-600 dark:bg-slate-900"
                        placeholder="0.00"
                        defaultValue={String(m.amount)}
                        onBlur={(e) =>
                          void updateManualLine(m.id, "amount", e.target.value)
                        }
                      />
                    </div>
                    <Button
                      type="button"
                      variant="secondary"
                      className="text-xs"
                      onClick={() => void removeManualLine(m.id)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-lg border border-navy/10 dark:border-slate-700">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface dark:bg-slate-800/80">
              <tr>
                <th className="px-3 py-2 text-left font-semibold text-navy dark:text-slate-200">
                  Lot #
                </th>
                <th className="px-3 py-2 text-left font-semibold text-navy dark:text-slate-200">
                  Description
                </th>
                <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
                  Qty
                </th>
                <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
                  Unit
                </th>
                <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
                  Line total
                </th>
                {invoice.status === "unpaid" ? (
                  <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-navy/10 dark:divide-slate-700">
              {sales.length === 0 && manualLines.length === 0 ? (
                <tr>
                  <td
                    colSpan={invoice.status === "unpaid" ? 6 : 5}
                    className="px-3 py-4 text-center text-muted"
                  >
                    No line items
                  </td>
                </tr>
              ) : null}
              {sales.map((s) => (
                <tr key={s.id}>
                  <td className="px-3 py-2 font-mono">{s.displayLotNumber}</td>
                  <td className="px-3 py-2">{s.description}</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {s.quantity}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(saleUnitHammer(s), sym)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(s.amount, sym)}
                  </td>
                  {invoice.status === "unpaid" ? (
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          type="button"
                          variant="secondary"
                          className="text-xs"
                          onClick={() => setCorrectionSale(s)}
                        >
                          Correct
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          className="text-xs"
                          onClick={() => void handleRemoveSaleFromInvoice(s)}
                        >
                          Remove
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {manualLines.map((m) => (
                <tr key={m.id}>
                  <td className="px-3 py-2 font-mono text-muted">—</td>
                  <td className="px-3 py-2">
                    {m.description || "Adjustment"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">1</td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(m.amount, sym)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {formatCurrency(m.amount, sym)}
                  </td>
                  {invoice.status === "unpaid" ? (
                    <td className="px-3 py-2 text-muted">—</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {invoice.status === "unpaid" && manualLines.length > 0 ? (
          <p className="text-xs text-muted">
            Manual lines appear in the PDF after clerking lines. Edit amounts
            on blur to update totals.
          </p>
        ) : null}

        <dl className="space-y-1 border-t border-navy/10 pt-3 text-right font-mono">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Hammer subtotal</dt>
            <dd>{formatCurrency(invoice.subtotal, sym)}</dd>
          </div>
          {showBpLine ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">
                {buyersPremiumLineLabel(bpEff)}
              </dt>
              <dd>{formatCurrency(invoice.buyersPremiumAmount, sym)}</dd>
            </div>
          ) : null}
          {invoice.taxAmount !== 0 || taxEff > 0 ? (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">{taxLineLabel(taxEff)}</dt>
              <dd>{formatCurrency(invoice.taxAmount, sym)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-4 text-base font-semibold text-navy dark:text-slate-100">
            <dt>Total</dt>
            <dd>{formatCurrency(invoice.total, sym)}</dd>
          </div>
        </dl>
      </div>
    </Modal>
    <SaleCorrectionModal
      open={correctionSale != null}
      sale={correctionSale}
      anchorInvoiceId={inv.id}
      event={event}
      currencySymbol={sym}
      onClose={() => setCorrectionSale(null)}
      onSaved={() => onSuccess?.("Sale updated.")}
      onError={onError}
    />
    </>
  );
}
