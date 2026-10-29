import type { AuctionDB, Invoice, Sale } from "@/lib/db";
import { newEntitySyncKey } from "@/lib/utils/clientSyncKey";
import { isSyncOpsEnabled } from "@/lib/sync/syncOpsFlag";
import type {
  InvoicePatchBody,
  InvoicePutBody,
  SaleDeleteBody,
  SalePutBody,
} from "@/lib/sync/ops/types";

async function newOpId(): Promise<string> {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function ensureSaleSyncKey(
  db: AuctionDB,
  saleId: number
): Promise<string | undefined> {
  const s = await db.sales.get(saleId);
  if (!s?.id) return undefined;
  if (s.syncKey) return s.syncKey;
  const key = newEntitySyncKey();
  await db.sales.update(saleId, { syncKey: key });
  return key;
}

export async function ensureInvoiceSyncKey(
  db: AuctionDB,
  invoiceId: number
): Promise<string | undefined> {
  const inv = await db.invoices.get(invoiceId);
  if (!inv?.id) return undefined;
  if (inv.syncKey) return inv.syncKey;
  const key = newEntitySyncKey();
  await db.invoices.update(invoiceId, { syncKey: key });
  return key;
}

async function appendOutbox(
  db: AuctionDB,
  eventSyncId: string,
  opType: string,
  body: unknown
): Promise<void> {
  if (!isSyncOpsEnabled()) return;
  const opId = await newOpId();
  await db.syncOutbox.add({
    eventSyncId,
    opId,
    opType,
    body,
    createdAt: new Date(),
  });
}

export async function saleRowToPutBody(
  db: AuctionDB,
  sale: Sale
): Promise<SalePutBody | null> {
  if (!sale.syncKey) return null;
  // null, not omitted, when the sale is off every invoice: a removal must
  // reach other devices (#84).
  let invoiceSyncKey: string | null | undefined;
  if (sale.invoiceId == null) {
    invoiceSyncKey = null;
  } else {
    const inv = await db.invoices.get(sale.invoiceId);
    if (inv?.syncKey) invoiceSyncKey = inv.syncKey;
  }
  return {
    saleSyncKey: sale.syncKey,
    displayLotNumber: sale.displayLotNumber,
    paddleNumber: sale.paddleNumber,
    description: sale.description,
    consignor: sale.consignor,
    consignorNumber:
      sale.consignorId != null
        ? (await db.consignors.get(sale.consignorId))?.consignorNumber ?? null
        : null,
    quantity: sale.quantity,
    amount: sale.amount,
    clerkInitials: sale.clerkInitials,
    createdAt:
      sale.createdAt instanceof Date
        ? sale.createdAt.toISOString()
        : String(sale.createdAt),
    invoiceSyncKey,
  };
}

export async function buildInvoicePutBodyFromDb(
  db: AuctionDB,
  inv: Invoice
): Promise<InvoicePutBody | null> {
  if (!inv.syncKey) return null;
  const bidder = await db.bidders.get(inv.bidderId);
  if (!bidder) return null;
  return {
    invoiceSyncKey: inv.syncKey,
    invoiceNumber: inv.invoiceNumber,
    paddleNumber: bidder.paddleNumber,
    status: inv.status,
    subtotal: inv.subtotal,
    buyersPremiumAmount: inv.buyersPremiumAmount,
    taxAmount: inv.taxAmount,
    total: inv.total,
    generatedAt:
      inv.generatedAt instanceof Date
        ? inv.generatedAt.toISOString()
        : String(inv.generatedAt),
    buyersPremiumRate: inv.buyersPremiumRate,
    taxRate: inv.taxRate,
    manualLines: inv.manualLines,
    paymentMethod: inv.paymentMethod,
    paymentDate:
      inv.paymentDate instanceof Date
        ? inv.paymentDate.toISOString()
        : inv.paymentDate
          ? String(inv.paymentDate)
          : null,
  };
}

export async function enqueueSalePut(
  db: AuctionDB,
  eventSyncId: string,
  sale: Sale
): Promise<void> {
  if (!isSyncOpsEnabled()) return;
  if (sale.id == null) return;
  const key = sale.syncKey ?? (await ensureSaleSyncKey(db, sale.id));
  if (!key) return;
  const withKey = { ...sale, syncKey: key };
  const body = await saleRowToPutBody(db, withKey);
  if (!body) return;
  await appendOutbox(db, eventSyncId, "sale.put", body);
}

export async function enqueueSaleDelete(
  db: AuctionDB,
  eventSyncId: string,
  saleSyncKey: string
): Promise<void> {
  if (!isSyncOpsEnabled()) return;
  const body: SaleDeleteBody = { saleSyncKey };
  await appendOutbox(db, eventSyncId, "sale.delete", body);
}

export async function enqueueInvoicePut(
  db: AuctionDB,
  eventSyncId: string,
  invoiceId: number
): Promise<void> {
  if (!isSyncOpsEnabled()) return;
  await ensureInvoiceSyncKey(db, invoiceId);
  const inv = await db.invoices.get(invoiceId);
  if (!inv) return;
  const body = await buildInvoicePutBodyFromDb(db, inv);
  if (!body) return;
  await appendOutbox(db, eventSyncId, "invoice.put", body);
}

export async function enqueueInvoicePatch(
  db: AuctionDB,
  eventSyncId: string,
  invoiceId: number,
  patch: Record<string, unknown>,
  recalculate?: boolean
): Promise<void> {
  if (!isSyncOpsEnabled()) return;
  const key = await ensureInvoiceSyncKey(db, invoiceId);
  if (!key) return;
  const body: InvoicePatchBody = {
    invoiceSyncKey: key,
    patch,
    recalculate: recalculate === true,
  };
  await appendOutbox(db, eventSyncId, "invoice.patch", body);
}
