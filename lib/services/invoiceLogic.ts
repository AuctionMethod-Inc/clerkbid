import type {
  AuctionDB,
  AuctionEvent,
  Bidder,
  Invoice,
  InvoiceManualLine,
  Sale,
} from "@/lib/db";
import { newEntitySyncKey } from "@/lib/utils/clientSyncKey";
import { enqueueInvoicePut } from "@/lib/sync/ops/enqueueOps";
import type { InvoicePdfInput } from "@/lib/services/invoicePdf";
import {
  resolveInvoiceBrandingForPdf,
  resolveInvoiceFooterText,
  type ResolvedInvoiceBranding,
} from "@/lib/services/invoiceBranding";
import { saleUnitHammer } from "@/lib/services/saleLineTotals";

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Invoice/sync may store rates as strings; clerks often enter whole percents (e.g. 8.75 for 8.75%).
 * Values in (1, 100] are treated as percent and divided by 100.
 */
function normalizeInvoiceRateOverride(raw: unknown): number | undefined {
  if (raw === null || raw === undefined) return undefined;
  let n: number;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    n = raw;
  } else if (typeof raw === "string") {
    const p = parseFloat(raw.trim());
    if (!Number.isFinite(p)) return undefined;
    n = p;
  } else {
    return undefined;
  }
  if (n > 1 && n <= 100) {
    n = n / 100;
  }
  return Math.max(0, n);
}

export function computeInvoiceFromSubtotal(
  subtotal: number,
  taxRate: number
): { subtotal: number; taxAmount: number; total: number } {
  const s = roundMoney(subtotal);
  const taxAmount = roundMoney(s * taxRate);
  const total = roundMoney(s + taxAmount);
  return { subtotal: s, taxAmount, total };
}

/** Resolved BP rate (0–1) for invoice math and labels. */
export function effectiveInvoiceBuyersPremiumRate(
  invoice: Pick<Invoice, "buyersPremiumRate">,
  event: AuctionEvent
): number {
  const o = normalizeInvoiceRateOverride(invoice.buyersPremiumRate);
  if (o !== undefined) {
    return o;
  }
  let e = Math.max(0, event.buyersPremiumRate ?? 0);
  if (e > 1 && e <= 100) {
    e = e / 100;
  }
  return e;
}

/** Resolved tax rate (0–1) for invoice math and labels. */
export function effectiveInvoiceTaxRate(
  invoice: Pick<Invoice, "taxRate">,
  event: AuctionEvent
): number {
  const o = normalizeInvoiceRateOverride(invoice.taxRate);
  if (o !== undefined) {
    return o;
  }
  let e = Math.max(0, event.taxRate ?? 0);
  if (e > 1 && e <= 100) {
    e = e / 100;
  }
  return e;
}

/**
 * Hammer from sales only; BP on hammer; manual lines after BP; tax on pre-tax subtotal.
 */
export function computeInvoiceTotalsFromParts(
  hammerSubtotal: number,
  manualLines: InvoiceManualLine[] | undefined,
  invoice: Pick<Invoice, "buyersPremiumRate" | "taxRate">,
  event: AuctionEvent
): {
  subtotal: number;
  buyersPremiumAmount: number;
  taxAmount: number;
  total: number;
} {
  const hammer = roundMoney(hammerSubtotal);
  const manualSum = roundMoney(
    (manualLines ?? []).reduce(
      (a, m) => a + (Number.isFinite(m.amount) ? m.amount : 0),
      0
    )
  );
  const bpRate = effectiveInvoiceBuyersPremiumRate(invoice, event);
  const buyersPremiumAmount = roundMoney(hammer * bpRate);
  const preTax = roundMoney(hammer + buyersPremiumAmount + manualSum);
  const taxRate = effectiveInvoiceTaxRate(invoice, event);
  const taxAmount = roundMoney(preTax * taxRate);
  const total = roundMoney(preTax + taxAmount);
  return {
    subtotal: hammer,
    buyersPremiumAmount,
    taxAmount,
    total,
  };
}

export function formatInvoiceNumber(eventId: number, seq: number): string {
  return `${eventId}-${String(seq).padStart(3, "0")}`;
}

export async function nextInvoiceSequence(
  db: AuctionDB,
  eventId: number
): Promise<number> {
  const all = await db.invoices.where("eventId").equals(eventId).toArray();
  let max = 0;
  for (const inv of all) {
    const part = inv.invoiceNumber.split("-").pop();
    const seq = part ? parseInt(part, 10) : NaN;
    if (Number.isFinite(seq) && seq > max) max = seq;
  }
  return max + 1;
}

export async function bidderIdsWithSales(
  db: AuctionDB,
  eventId: number
): Promise<number[]> {
  const sales = await db.sales.where("eventId").equals(eventId).toArray();
  return Array.from(new Set(sales.map((s) => s.bidderId)));
}

export type UpsertResult =
  | { kind: "created"; invoiceId: number }
  | { kind: "updated"; invoiceId: number }
  | { kind: "unchanged"; invoiceId: number }
  | { kind: "skipped_paid" }
  | { kind: "no_sales" };

/**
 * Recompute persisted totals from sales + manual lines + effective rates.
 * No-op for paid invoices and when unpaid totals are already current.
 * Returns whether the invoice (or parent event) was written.
 */
export async function recalculateAndPersistInvoice(
  db: AuctionDB,
  invoiceId: number,
  event: AuctionEvent,
  options?: { touchGeneratedAt?: boolean }
): Promise<boolean> {
  const inv = await db.invoices.get(invoiceId);
  if (inv?.id == null || inv.status === "paid") return false;

  const lineSales = await getSalesForInvoice(db, invoiceId);
  const hammerSubtotal = roundMoney(
    lineSales.reduce((a, s) => a + s.amount, 0)
  );
  const parts = computeInvoiceTotalsFromParts(
    hammerSubtotal,
    inv.manualLines,
    inv,
    event
  );
  const totalsUnchanged =
    roundMoney(inv.subtotal) === parts.subtotal &&
    roundMoney(inv.buyersPremiumAmount) === parts.buyersPremiumAmount &&
    roundMoney(inv.taxAmount) === parts.taxAmount &&
    roundMoney(inv.total) === parts.total;
  if (totalsUnchanged) return false;

  await db.transaction("rw", [db.events, db.invoices], async () => {
    await db.events.update(inv.eventId, { updatedAt: new Date() });
    await db.invoices.update(invoiceId, {
      subtotal: parts.subtotal,
      buyersPremiumAmount: parts.buyersPremiumAmount,
      taxAmount: parts.taxAmount,
      total: parts.total,
      ...(options?.touchGeneratedAt ? { generatedAt: new Date() } : {}),
    });
  });
  return true;
}

/**
 * If this bidder already has an unpaid invoice, attach unallocated sales to it
 * and persist new totals. Does not create invoices (Generate still does that).
 * Returns null when there is no unpaid invoice to absorb into.
 */
export async function attachUnallocatedSalesToUnpaidInvoice(
  db: AuctionDB,
  event: AuctionEvent,
  bidderId: number
): Promise<UpsertResult | null> {
  const eventId = event.id!;
  const allSales = await db.sales
    .where("eventId")
    .equals(eventId)
    .filter((s) => s.bidderId === bidderId)
    .toArray();
  if (allSales.length === 0) return { kind: "no_sales" };

  const invs = await db.invoices
    .where("eventId")
    .equals(eventId)
    .filter((i) => i.bidderId === bidderId)
    .toArray();
  const unpaid = invs
    .filter((i) => i.status === "unpaid")
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))[0];
  if (unpaid?.id == null) return null;

  const unallocated = allSales.filter((s) => s.invoiceId == null);
  const allocated = unallocated.length > 0;
  if (allocated) {
    await db.transaction("rw", [db.events, db.sales], async () => {
      await db.events.update(eventId, { updatedAt: new Date() });
      for (const s of unallocated) {
        if (s.id != null) {
          await db.sales.update(s.id, { invoiceId: unpaid.id });
        }
      }
    });
  }
  const wrote = await recalculateAndPersistInvoice(db, unpaid.id, event, {
    touchGeneratedAt: allocated,
  });
  if ((wrote || allocated) && event.syncId) {
    await enqueueInvoicePut(db, event.syncId, unpaid.id);
  }
  if (wrote || allocated) {
    return { kind: "updated", invoiceId: unpaid.id };
  }
  return { kind: "unchanged", invoiceId: unpaid.id };
}

/**
 * Allocates sales to invoices via `sale.invoiceId`.
 * Unpaid invoice absorbs any unallocated lines; paid invoices are never changed.
 * After the bidder’s invoices are all paid, new unallocated sales get a new supplemental invoice.
 */
export async function upsertInvoiceForBidder(
  db: AuctionDB,
  event: AuctionEvent,
  bidderId: number
): Promise<UpsertResult> {
  const eventId = event.id!;
  const absorbed = await attachUnallocatedSalesToUnpaidInvoice(
    db,
    event,
    bidderId
  );
  if (absorbed) return absorbed;

  const allSales = await db.sales
    .where("eventId")
    .equals(eventId)
    .filter((s) => s.bidderId === bidderId)
    .toArray();

  if (allSales.length === 0) return { kind: "no_sales" };

  const unallocated = allSales.filter((s) => s.invoiceId == null);
  const now = new Date();

  if (unallocated.length > 0) {
    const seq = await nextInvoiceSequence(db, eventId);
    const invoiceNumber = formatInvoiceNumber(eventId, seq);
    let id = 0;
    await db.transaction("rw", [db.events, db.invoices, db.sales], async () => {
      await db.events.update(eventId, { updatedAt: new Date() });
      id = (await db.invoices.add({
        eventId,
        bidderId,
        invoiceNumber,
        subtotal: 0,
        buyersPremiumAmount: 0,
        taxAmount: 0,
        total: 0,
        status: "unpaid",
        generatedAt: now,
        syncKey: newEntitySyncKey(),
      })) as number;
      for (const s of unallocated) {
        if (s.id != null) {
          await db.sales.update(s.id, { invoiceId: id });
        }
      }
    });
    await recalculateAndPersistInvoice(db, id, event, {
      touchGeneratedAt: true,
    });
    if (event.syncId) {
      await enqueueInvoicePut(db, event.syncId, id);
    }
    return { kind: "created", invoiceId: id };
  }

  return { kind: "skipped_paid" };
}

export async function generateAllInvoicesForEvent(
  db: AuctionDB,
  eventId: number
): Promise<{
  created: number;
  updated: number;
  skippedPaid: number;
  noSales: number;
}> {
  const event = await db.events.get(eventId);
  if (!event?.id) throw new Error("Event not found");

  const bidderIds = await bidderIdsWithSales(db, eventId);

  let created = 0;
  let updated = 0;
  let skippedPaid = 0;
  let noSales = 0;

  for (const bidderId of bidderIds) {
    const r = await upsertInvoiceForBidder(db, event, bidderId);
    if (r.kind === "created") created++;
    else if (r.kind === "updated") updated++;
    else if (r.kind === "skipped_paid") skippedPaid++;
    else if (r.kind === "no_sales") noSales++;
  }

  return { created, updated, skippedPaid, noSales };
}

export async function getSalesForInvoice(
  db: AuctionDB,
  invoiceId: number
): Promise<Sale[]> {
  const rows = await db.sales.where("invoiceId").equals(invoiceId).toArray();
  rows.sort((a, b) =>
    a.displayLotNumber.localeCompare(b.displayLotNumber, undefined, {
      numeric: true,
    })
  );
  return rows;
}

/**
 * Resolves the current invoice row after cloud snapshot replace (which deletes
 * child tables and re-inserts with new auto-increment ids). The modal may still
 * hold a stale numeric `id` while `syncKey` / display keys still match one row.
 */
export async function resolveInvoiceForOpenDetail(
  db: AuctionDB,
  eventId: number,
  hint: Pick<Invoice, "id" | "syncKey" | "invoiceNumber" | "bidderId">
): Promise<Invoice | null> {
  if (hint.id == null) return null;
  const byId = await db.invoices.get(hint.id);
  if (byId) return byId;
  const rows = await db.invoices.where("eventId").equals(eventId).toArray();
  if (hint.syncKey) {
    const m = rows.find((i) => i.syncKey === hint.syncKey);
    if (m) return m;
  }
  if (hint.invoiceNumber != null && hint.bidderId != null) {
    const m = rows.find(
      (i) =>
        i.invoiceNumber === hint.invoiceNumber && i.bidderId === hint.bidderId
    );
    if (m) return m;
  }
  return null;
}

export function toInvoicePdfInput(
  invoice: Invoice,
  event: AuctionEvent,
  bidder: Bidder,
  sales: Sale[],
  branding?: ResolvedInvoiceBranding | null
): InvoicePdfInput {
  const footerLine = branding
    ? branding.footerLine
    : resolveInvoiceFooterText(null, event.organizationName);
  const bpRateEff = effectiveInvoiceBuyersPremiumRate(invoice, event);
  const taxRateEff = effectiveInvoiceTaxRate(invoice, event);

  const saleLines = sales.map((s) => ({
    displayLotNumber: s.displayLotNumber,
    description: s.description,
    quantity: s.quantity,
    unitHammer: saleUnitHammer(s),
    lineHammer: roundMoney(s.amount),
  }));

  const manualLines = invoice.manualLines ?? [];
  const manualPdfLines = manualLines.map((m) => ({
    displayLotNumber: "—",
    description: m.description || "Adjustment",
    quantity: 1,
    unitHammer: roundMoney(m.amount),
    lineHammer: roundMoney(m.amount),
  }));

  return {
    organizationName: event.organizationName,
    eventName: event.name,
    invoiceNumber: invoice.invoiceNumber,
    generatedAt: invoice.generatedAt,
    taxRate: taxRateEff,
    buyersPremiumRate: bpRateEff,
    currencySymbol: event.currencySymbol,
    bidderName: `${bidder.firstName} ${bidder.lastName}`,
    paddleNumber: bidder.paddleNumber,
    phone: bidder.phone,
    email: bidder.email,
    mailingAddress: bidder.mailingAddress,
    resaleNumber: bidder.resaleNumber,
    status: invoice.status,
    paymentMethod: invoice.paymentMethod,
    paymentDate: invoice.paymentDate,
    lines: [...saleLines, ...manualPdfLines],
    hammerSubtotal: invoice.subtotal,
    buyersPremiumAmount: invoice.buyersPremiumAmount,
    taxAmount: invoice.taxAmount,
    total: invoice.total,
    invoiceFooterLine: footerLine,
    invoiceLogoDataUrl: branding?.logoDataUrl,
    invoiceLogoWidthMm: branding?.logoWidthMm,
    invoiceLogoHeightMm: branding?.logoHeightMm,
  };
}

export async function loadInvoicePdfInput(
  db: AuctionDB,
  invoiceId: number
): Promise<InvoicePdfInput | null> {
  const inv = await db.invoices.get(invoiceId);
  if (inv?.id == null) return null;
  const [event, bidder] = await Promise.all([
    db.events.get(inv.eventId),
    db.bidders.get(inv.bidderId),
  ]);
  if (event?.id == null || bidder?.id == null) return null;
  const sales = await getSalesForInvoice(db, invoiceId);
  const branding = await resolveInvoiceBrandingForPdf(
    db,
    inv.eventId,
    event.organizationName
  );
  return toInvoicePdfInput(inv, event, bidder, sales, branding);
}

/** Bidders with at least one sale not yet linked to an invoice (`invoiceId` null). */
export async function bidderIdsPendingFirstInvoice(
  db: AuctionDB,
  eventId: number
): Promise<number[]> {
  const sales = await db.sales.where("eventId").equals(eventId).toArray();
  const ids = new Set<number>();
  for (const s of sales) {
    if (s.invoiceId == null) ids.add(s.bidderId);
  }
  return Array.from(ids);
}
