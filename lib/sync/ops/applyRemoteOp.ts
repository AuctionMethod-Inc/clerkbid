import type { AuctionDB, AuctionEvent, Invoice, Sale } from "@/lib/db";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";
import {
  computeInvoiceTotalsFromParts,
  attachUnallocatedSalesToUnpaidInvoice,
  recalculateAndPersistInvoice,
  roundMoney,
} from "@/lib/services/invoiceLogic";
import {
  parseInvoicePatchBody,
  parseInvoicePutBody,
  parseSaleDeleteBody,
  parseSalePutBody,
} from "@/lib/sync/ops/parseBodies";

export type ApplyRemoteOpResult =
  | { ok: true }
  | { ok: false; reason: string }
  | { ok: false; conflict: true; message: string };

async function findLotIdByDisplay(
  db: AuctionDB,
  eventId: number,
  displayLotNumber: string
): Promise<number | null> {
  const rows = await db.lots
    .where("eventId")
    .equals(eventId)
    .filter((l) => l.displayLotNumber === displayLotNumber)
    .toArray();
  if (rows.length === 0) return null;
  return rows[0]!.id ?? null;
}

async function findBidderIdByPaddle(
  db: AuctionDB,
  eventId: number,
  paddleNumber: number
): Promise<number | null> {
  const b = await db.bidders
    .where("[eventId+paddleNumber]")
    .equals([eventId, paddleNumber])
    .first();
  return b?.id ?? null;
}

function recordConflict(
  db: AuctionDB,
  eventSyncId: string,
  opType: string,
  message: string,
  payload?: unknown
): Promise<number> {
  return db.syncConflicts.add({
    eventSyncId,
    opType,
    detail: message,
    payload,
    createdAt: new Date(),
  }) as Promise<number>;
}

export async function applyRemoteOp(
  db: AuctionDB,
  event: AuctionEvent,
  eventSyncId: string,
  opType: string,
  body: unknown
): Promise<ApplyRemoteOpResult> {
  return withCloudSyncApply(() =>
    applyRemoteOpImpl(db, event, eventSyncId, opType, body)
  );
}

async function applyRemoteOpImpl(
  db: AuctionDB,
  event: AuctionEvent,
  eventSyncId: string,
  opType: string,
  body: unknown
): Promise<ApplyRemoteOpResult> {
  const eventId = event.id!;
  if (opType === "sale.put") {
    const p = parseSalePutBody(body);
    if (!p) return { ok: false, reason: "invalid sale.put body" };
    const lotId = await findLotIdByDisplay(db, eventId, p.displayLotNumber);
    const bidderId = await findBidderIdByPaddle(db, eventId, p.paddleNumber);
    if (lotId == null || bidderId == null) {
      await recordConflict(db, eventSyncId, opType, "sale.put: lot or bidder not found", {
        body: p,
      });
      return { ok: false, conflict: true, message: "Lot or bidder missing locally" };
    }
    const existing = await db.sales
      .where("eventId")
      .equals(eventId)
      .filter((s) => s.syncKey === p.saleSyncKey)
      .first();
    const createdAt = new Date(p.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return { ok: false, reason: "invalid createdAt" };
    }
    let invoiceId: number | null | undefined;
    if (p.invoiceSyncKey !== undefined) {
      if (p.invoiceSyncKey === null) {
        invoiceId = null;
      } else {
        const inv = await db.invoices
          .where("eventId")
          .equals(eventId)
          .filter((i) => i.syncKey === p.invoiceSyncKey)
          .first();
        invoiceId = inv?.id ?? null;
      }
    }
    if (existing?.id != null) {
      if (existing.lotId !== lotId || existing.bidderId !== bidderId) {
        await recordConflict(
          db,
          eventSyncId,
          opType,
          "sale.put: syncKey exists but lot/bidder mismatch",
          { saleSyncKey: p.saleSyncKey }
        );
        return {
          ok: false,
          conflict: true,
          message: "Sale identity conflict (lot/bidder)",
        };
      }
      const next: Sale = {
        ...existing,
        displayLotNumber: p.displayLotNumber,
        paddleNumber: p.paddleNumber,
        description: p.description,
        quantity: p.quantity,
        amount: roundMoney(p.amount),
        clerkInitials: p.clerkInitials,
        createdAt,
        syncKey: p.saleSyncKey,
      };
      if (p.consignor !== undefined) next.consignor = p.consignor;
      if (p.consignorNumber === null) delete next.consignorId;
      else if (typeof p.consignorNumber === "number") {
        const c = await db.consignors
          .where("eventId")
          .equals(eventId)
          .filter((x) => x.consignorNumber === p.consignorNumber)
          .first();
        if (c?.id != null) next.consignorId = c.id;
        else delete next.consignorId;
      }
      if (invoiceId !== undefined) {
        next.invoiceId = invoiceId;
      }
      await db.sales.put(next);
      if (existing.invoiceId != null) {
        await recalculateAndPersistInvoice(db, existing.invoiceId, event);
      }
      await attachUnallocatedSalesToUnpaidInvoice(db, event, bidderId);
      return { ok: true };
    }
    const row: Omit<Sale, "id"> = {
      eventId,
      lotId,
      bidderId,
      displayLotNumber: p.displayLotNumber,
      paddleNumber: p.paddleNumber,
      description: p.description,
      quantity: p.quantity,
      amount: roundMoney(p.amount),
      clerkInitials: p.clerkInitials,
      createdAt,
      syncKey: p.saleSyncKey,
    };
    if (p.consignor) row.consignor = p.consignor;
    if (typeof p.consignorNumber === "number") {
      const c = await db.consignors
        .where("eventId")
        .equals(eventId)
        .filter((x) => x.consignorNumber === p.consignorNumber)
        .first();
      if (c?.id != null) row.consignorId = c.id;
    }
    if (invoiceId != null) row.invoiceId = invoiceId;
    await db.sales.add(row);
    if (invoiceId != null) {
      await recalculateAndPersistInvoice(db, invoiceId, event);
    }
    await attachUnallocatedSalesToUnpaidInvoice(db, event, bidderId);
    return { ok: true };
  }

  if (opType === "sale.delete") {
    const p = parseSaleDeleteBody(body);
    if (!p) return { ok: false, reason: "invalid sale.delete body" };
    const s = await db.sales
      .where("eventId")
      .equals(eventId)
      .filter((x) => x.syncKey === p.saleSyncKey)
      .first();
    if (!s?.id) return { ok: true };
    const invId = s.invoiceId;
    await db.sales.delete(s.id);
    if (invId != null) {
      await recalculateAndPersistInvoice(db, invId, event);
    }
    return { ok: true };
  }

  if (opType === "invoice.put") {
    const p = parseInvoicePutBody(body);
    if (!p) return { ok: false, reason: "invalid invoice.put body" };
    const bidderId = await findBidderIdByPaddle(db, eventId, p.paddleNumber);
    if (bidderId == null) {
      await recordConflict(db, eventSyncId, opType, "invoice.put: bidder not found", {
        paddle: p.paddleNumber,
      });
      return { ok: false, conflict: true, message: "Bidder missing locally" };
    }
    const existing = await db.invoices
      .where("eventId")
      .equals(eventId)
      .filter((i) => i.syncKey === p.invoiceSyncKey)
      .first();
    const generatedAt = new Date(p.generatedAt);
    if (Number.isNaN(generatedAt.getTime())) {
      return { ok: false, reason: "invalid generatedAt" };
    }
    const paymentDate =
      p.paymentDate != null ? new Date(p.paymentDate) : undefined;
    if (p.paymentDate != null && Number.isNaN(paymentDate!.getTime())) {
      return { ok: false, reason: "invalid paymentDate" };
    }
    const base: Omit<Invoice, "id"> = {
      eventId,
      bidderId,
      invoiceNumber: p.invoiceNumber,
      subtotal: roundMoney(p.subtotal),
      buyersPremiumAmount: roundMoney(p.buyersPremiumAmount),
      taxAmount: roundMoney(p.taxAmount),
      total: roundMoney(p.total),
      status: p.status,
      generatedAt,
      syncKey: p.invoiceSyncKey,
      ...(p.paymentMethod != null ? { paymentMethod: p.paymentMethod } : {}),
      ...(paymentDate ? { paymentDate } : {}),
      ...(p.buyersPremiumRate !== undefined
        ? { buyersPremiumRate: p.buyersPremiumRate }
        : {}),
      ...(p.taxRate !== undefined ? { taxRate: p.taxRate } : {}),
      ...(p.manualLines != null ? { manualLines: p.manualLines } : {}),
    };
    if (existing?.id != null) {
      if (existing.bidderId !== bidderId) {
        await recordConflict(
          db,
          eventSyncId,
          opType,
          "invoice.put: syncKey exists but bidder mismatch",
          { invoiceSyncKey: p.invoiceSyncKey }
        );
        return {
          ok: false,
          conflict: true,
          message: "Invoice bidder conflict",
        };
      }
      await db.invoices.update(existing.id, base);
    } else {
      await db.invoices.add(base);
    }
    return { ok: true };
  }

  if (opType === "invoice.patch") {
    const p = parseInvoicePatchBody(body);
    if (!p) return { ok: false, reason: "invalid invoice.patch body" };
    const inv = await db.invoices
      .where("eventId")
      .equals(eventId)
      .filter((i) => i.syncKey === p.invoiceSyncKey)
      .first();
    if (!inv?.id) {
      await recordConflict(db, eventSyncId, opType, "invoice.patch: invoice not found", {
        invoiceSyncKey: p.invoiceSyncKey,
      });
      return { ok: false, conflict: true, message: "Invoice not found" };
    }
    if (inv.status === "paid" && Object.keys(p.patch).some((k) => k !== "status")) {
      await recordConflict(
        db,
        eventSyncId,
        opType,
        "invoice.patch: mutating paid invoice",
        { invoiceSyncKey: p.invoiceSyncKey, patch: p.patch }
      );
      return { ok: false, conflict: true, message: "Cannot patch paid invoice" };
    }
    await db.invoices.where("id").equals(inv.id).modify((row) => {
      for (const [k, v] of Object.entries(p.patch)) {
        if (k === "paymentDate") {
          if (v == null) delete row.paymentDate;
          else if (typeof v === "string") {
            const d = new Date(v);
            if (!Number.isNaN(d.getTime())) row.paymentDate = d;
          }
        } else if (k === "manualLines" && Array.isArray(v)) {
          row.manualLines = v as Invoice["manualLines"];
        } else if (k === "status" && (v === "paid" || v === "unpaid")) {
          row.status = v;
        } else if (
          k === "paymentMethod" &&
          (v === "cash" ||
            v === "check" ||
            v === "credit_card" ||
            v === "other" ||
            v == null)
        ) {
          if (v == null) delete row.paymentMethod;
          else row.paymentMethod = v;
        } else if (
          (k === "buyersPremiumRate" || k === "taxRate") &&
          (typeof v === "number" || v === null)
        ) {
          (row as unknown as Record<string, unknown>)[k] = v;
        }
      }
    });
    if (p.recalculate) {
      const fresh = await db.invoices.get(inv.id);
      if (fresh?.status === "unpaid") {
        await recalculateAndPersistInvoice(db, inv.id, event);
      }
    } else if (p.patch.subtotal != null || p.patch.manualLines != null) {
      const fresh = await db.invoices.get(inv.id);
      if (fresh?.status === "unpaid") {
        const lineSales = await db.sales.where("invoiceId").equals(inv.id).toArray();
        const hammerSubtotal = roundMoney(
          lineSales.reduce((a, s) => a + s.amount, 0)
        );
        const parts = computeInvoiceTotalsFromParts(
          hammerSubtotal,
          fresh.manualLines,
          fresh,
          event
        );
        await db.invoices.update(inv.id, {
          subtotal: parts.subtotal,
          buyersPremiumAmount: parts.buyersPremiumAmount,
          taxAmount: parts.taxAmount,
          total: parts.total,
        });
      }
    }
    return { ok: true };
  }

  return { ok: false, reason: `unknown opType ${opType}` };
}
