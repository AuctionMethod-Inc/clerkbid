import type { AuctionDB, Bidder, Consignor, Invoice, Lot, Sale } from "@/lib/db";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";
import { newEntitySyncKey } from "@/lib/utils/clientSyncKey";
import { toDate } from "@/lib/utils/coerceDate";
import type { EventExportPayload } from "@/lib/services/dataPorter";
import { roundMoney } from "@/lib/services/invoiceLogic";

function safeMs(d: Date | string | number | undefined | null): number {
  const parsed = toDate(d);
  return parsed ? parsed.getTime() : 0;
}

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

function invoiceSnapshotFieldsEqual(
  local: Invoice,
  server: EventExportPayload["invoices"][number],
  resolvedBidderId: number
): boolean {
  return (
    local.bidderId === resolvedBidderId &&
    local.invoiceNumber === server.invoiceNumber &&
    roundMoney(local.subtotal) === roundMoney(server.subtotal) &&
    roundMoney(local.buyersPremiumAmount) ===
      roundMoney(server.buyersPremiumAmount) &&
    roundMoney(local.taxAmount) === roundMoney(server.taxAmount) &&
    roundMoney(local.total) === roundMoney(server.total) &&
    local.status === server.status &&
    (local.paymentMethod ?? undefined) === (server.paymentMethod ?? undefined) &&
    safeMs(local.paymentDate) === safeMs(server.paymentDate) &&
    (local.buyersPremiumRate ?? undefined) ===
      (server.buyersPremiumRate ?? undefined) &&
    (local.taxRate ?? undefined) === (server.taxRate ?? undefined) &&
    JSON.stringify(local.manualLines ?? []) ===
      JSON.stringify(server.manualLines ?? [])
  );
}

export type MergeSummary = {
  biddersAdded: number;
  biddersUpdated: number;
  consignorsAdded: number;
  consignorsUpdated: number;
  lotsAdded: number;
  lotsUpdated: number;
  salesAdded: number;
  salesUpdated: number;
  invoicesAdded: number;
  invoicesUpdated: number;
};

/**
 * Merge a server snapshot into local Dexie data for a given event, without
 * destroying local-only entities. For each entity type, server entities that
 * don't exist locally are added; entities present on both sides are updated
 * if the server copy is newer.
 *
 * Wrapped in `withCloudSyncApply` so Dexie hooks don't bump `updatedAt`
 * during the merge (which would re-trigger the "dirty" flag).
 */
export async function mergeServerSnapshotIntoLocal(
  db: AuctionDB,
  eventId: number,
  serverPayload: EventExportPayload
): Promise<MergeSummary> {
  return withCloudSyncApply(() =>
    db.transaction(
      "rw",
      [db.events, db.bidders, db.consignors, db.lots, db.sales, db.invoices],
      () => mergeImpl(db, eventId, serverPayload)
    )
  );
}

// ---------------------------------------------------------------------------
// Build lookup tables from the server export so we can resolve legacy FK ids
// to natural keys (paddleNumber, displayLotNumber, consignorNumber, syncKey).
// ---------------------------------------------------------------------------

type ServerLookups = {
  bidderPaddleByLegacyId: Map<number, number>;
  consignorNumByLegacyId: Map<number, number>;
  lotDisplayByLegacyId: Map<number, string>;
  invoiceSyncKeyByLegacyId: Map<number, string>;
};

function buildServerLookups(server: EventExportPayload): ServerLookups {
  const bidderPaddleByLegacyId = new Map<number, number>();
  for (const b of server.bidders) {
    if (b.legacyId != null) bidderPaddleByLegacyId.set(b.legacyId, b.paddleNumber);
  }
  const consignorNumByLegacyId = new Map<number, number>();
  for (const c of server.consignors ?? []) {
    if (c.legacyId != null) consignorNumByLegacyId.set(c.legacyId, c.consignorNumber);
  }
  const lotDisplayByLegacyId = new Map<number, string>();
  for (const l of server.lots) {
    if (l.legacyId != null) lotDisplayByLegacyId.set(l.legacyId, l.displayLotNumber);
  }
  const invoiceSyncKeyByLegacyId = new Map<number, string>();
  for (const inv of server.invoices) {
    if (inv.legacyId != null && inv.syncKey) {
      invoiceSyncKeyByLegacyId.set(inv.legacyId, inv.syncKey);
    }
  }
  return { bidderPaddleByLegacyId, consignorNumByLegacyId, lotDisplayByLegacyId, invoiceSyncKeyByLegacyId };
}

// ---------------------------------------------------------------------------

async function mergeImpl(
  db: AuctionDB,
  eventId: number,
  server: EventExportPayload
): Promise<MergeSummary> {
  const summary: MergeSummary = {
    biddersAdded: 0, biddersUpdated: 0,
    consignorsAdded: 0, consignorsUpdated: 0,
    lotsAdded: 0, lotsUpdated: 0,
    salesAdded: 0, salesUpdated: 0,
    invoicesAdded: 0, invoicesUpdated: 0,
  };

  const event = await db.events.get(eventId);
  if (!event) throw new Error("Event not found for merge");

  const sLookups = buildServerLookups(server);

  // --- Merge event-level metadata (server wins for config fields) ---
  const sev = server.event;
  await db.events.update(eventId, {
    name: sev.name,
    organizationName: sev.organizationName,
    taxRate: sev.taxRate,
    buyersPremiumRate:
      typeof sev.buyersPremiumRate === "number" && Number.isFinite(sev.buyersPremiumRate)
        ? Math.max(0, sev.buyersPremiumRate)
        : event.buyersPremiumRate,
    defaultConsignorCommissionRate:
      typeof sev.defaultConsignorCommissionRate === "number" &&
      Number.isFinite(sev.defaultConsignorCommissionRate)
        ? Math.max(0, Math.min(1, sev.defaultConsignorCommissionRate))
        : event.defaultConsignorCommissionRate,
    currencySymbol: sev.currencySymbol,
    description: sev.description,
  });

  // --- Bidders: match by paddleNumber ---
  const localBidders = await db.bidders.where("eventId").equals(eventId).toArray();
  const localBidderByPaddle = new Map<number, Bidder>();
  for (const b of localBidders) localBidderByPaddle.set(b.paddleNumber, b);

  for (const sb of server.bidders) {
    const local = localBidderByPaddle.get(sb.paddleNumber);
    if (!local) {
      await db.bidders.add({
        eventId,
        paddleNumber: sb.paddleNumber,
        firstName: sb.firstName,
        lastName: sb.lastName,
        phone: sb.phone,
        email: sb.email,
        mailingAddress: sb.mailingAddress,
        resaleNumber: sb.resaleNumber,
        masterSyncKey: sb.masterSyncKey,
        createdAt: parseDate(sb.createdAt),
        updatedAt: parseDate(sb.updatedAt),
      });
      summary.biddersAdded++;
    } else if (safeMs(sb.updatedAt) > safeMs(local.updatedAt)) {
      await db.bidders.update(local.id!, {
        firstName: sb.firstName,
        lastName: sb.lastName,
        phone: sb.phone,
        email: sb.email,
        mailingAddress: sb.mailingAddress,
        resaleNumber: sb.resaleNumber,
        masterSyncKey: sb.masterSyncKey,
        updatedAt: parseDate(sb.updatedAt),
      });
      summary.biddersUpdated++;
    }
  }

  // --- Consignors: match by consignorNumber ---
  const localConsignors = await db.consignors.where("eventId").equals(eventId).toArray();
  const localConsignorByNum = new Map<number, Consignor>();
  for (const c of localConsignors) localConsignorByNum.set(c.consignorNumber, c);

  for (const sc of server.consignors ?? []) {
    const local = localConsignorByNum.get(sc.consignorNumber);
    if (!local) {
      await db.consignors.add({
        eventId,
        consignorNumber: sc.consignorNumber,
        name: sc.name,
        email: sc.email,
        phone: sc.phone,
        mailingAddress: sc.mailingAddress,
        notes: sc.notes,
        commissionRate: sc.commissionRate,
        masterSyncKey: sc.masterSyncKey,
        createdAt: parseDate(sc.createdAt),
        updatedAt: parseDate(sc.updatedAt),
      });
      summary.consignorsAdded++;
    } else if (safeMs(sc.updatedAt) > safeMs(local.updatedAt)) {
      await db.consignors.update(local.id!, {
        name: sc.name,
        email: sc.email,
        phone: sc.phone,
        mailingAddress: sc.mailingAddress,
        notes: sc.notes,
        commissionRate: sc.commissionRate,
        masterSyncKey: sc.masterSyncKey,
        updatedAt: parseDate(sc.updatedAt),
      });
      summary.consignorsUpdated++;
    }
  }

  // --- Lots: match by displayLotNumber ---
  const localLots = await db.lots.where("eventId").equals(eventId).toArray();
  const localLotByDisplay = new Map<string, Lot>();
  for (const l of localLots) localLotByDisplay.set(l.displayLotNumber, l);

  // Build fresh consignor id map after merging consignors above
  const freshConsignors = await db.consignors.where("eventId").equals(eventId).toArray();
  const consignorIdByNum = new Map<number, number>();
  for (const c of freshConsignors) if (c.id != null) consignorIdByNum.set(c.consignorNumber, c.id);

  for (const sl of server.lots) {
    const local = localLotByDisplay.get(sl.displayLotNumber);
    // Resolve consignorId: legacyConsignorId -> consignorNumber (via server lookup) -> local id
    let consignorId: number | undefined;
    if (sl.legacyConsignorId != null) {
      const cNum = sLookups.consignorNumByLegacyId.get(sl.legacyConsignorId);
      if (cNum != null) consignorId = consignorIdByNum.get(cNum);
    }

    if (!local) {
      await db.lots.add({
        eventId,
        baseLotNumber: sl.baseLotNumber,
        lotSuffix: sl.lotSuffix,
        displayLotNumber: sl.displayLotNumber,
        description: sl.description,
        consignor: sl.consignor,
        ...(consignorId != null ? { consignorId } : {}),
        notes: sl.notes,
        quantity: sl.quantity,
        status: sl.status,
        createdAt: parseDate(sl.createdAt),
        updatedAt: parseDate(sl.updatedAt),
      });
      summary.lotsAdded++;
    } else if (safeMs(sl.updatedAt) > safeMs(local.updatedAt)) {
      await db.lots.update(local.id!, {
        baseLotNumber: sl.baseLotNumber,
        lotSuffix: sl.lotSuffix,
        description: sl.description,
        consignor: sl.consignor,
        ...(consignorId != null ? { consignorId } : {}),
        notes: sl.notes,
        quantity: sl.quantity,
        status: sl.status,
        updatedAt: parseDate(sl.updatedAt),
      });
      summary.lotsUpdated++;
    }
  }

  // Build fresh FK lookup maps after merging bidders, lots, consignors
  const freshBidders = await db.bidders.where("eventId").equals(eventId).toArray();
  const bidderIdByPaddle = new Map<number, number>();
  for (const b of freshBidders) if (b.id != null) bidderIdByPaddle.set(b.paddleNumber, b.id);

  const freshLots = await db.lots.where("eventId").equals(eventId).toArray();
  const lotIdByDisplay = new Map<string, number>();
  for (const l of freshLots) if (l.id != null) lotIdByDisplay.set(l.displayLotNumber, l.id);

  // --- Invoices: match by syncKey (before sales so invoiceId FK can resolve) ---
  const localInvoices = await db.invoices.where("eventId").equals(eventId).toArray();
  const localInvBySyncKey = new Map<string, Invoice>();
  for (const inv of localInvoices) {
    if (inv.syncKey) localInvBySyncKey.set(inv.syncKey, inv);
  }

  const invoiceIdBySyncKey = new Map<string, number>();
  for (const inv of localInvoices) {
    if (inv.syncKey && inv.id != null) invoiceIdBySyncKey.set(inv.syncKey, inv.id);
  }

  for (const sinv of server.invoices) {
    const sk = sinv.syncKey || newEntitySyncKey();
    // Resolve bidder: legacyBidderId -> paddleNumber (via server lookup) -> local id
    const paddle = sinv.legacyBidderId != null
      ? sLookups.bidderPaddleByLegacyId.get(sinv.legacyBidderId)
      : undefined;
    const resolvedBidderId = paddle != null ? bidderIdByPaddle.get(paddle) : undefined;
    if (resolvedBidderId == null) continue;

    const local = localInvBySyncKey.get(sk);
    if (!local) {
      const newId = (await db.invoices.add({
        eventId,
        bidderId: resolvedBidderId,
        invoiceNumber: sinv.invoiceNumber,
        subtotal: roundMoney(sinv.subtotal),
        buyersPremiumAmount: roundMoney(sinv.buyersPremiumAmount),
        taxAmount: sinv.taxAmount,
        total: sinv.total,
        status: sinv.status,
        paymentMethod: sinv.paymentMethod,
        paymentDate: sinv.paymentDate ? parseDate(sinv.paymentDate) : undefined,
        generatedAt: parseDate(sinv.generatedAt),
        buyersPremiumRate: sinv.buyersPremiumRate,
        taxRate: sinv.taxRate,
        manualLines: sinv.manualLines,
        syncKey: sk,
      })) as number;
      invoiceIdBySyncKey.set(sk, newId);
      summary.invoicesAdded++;
    } else {
      if (
        safeMs(sinv.generatedAt) > safeMs(local.generatedAt) &&
        !invoiceSnapshotFieldsEqual(local, sinv, resolvedBidderId)
      ) {
        await db.invoices.update(local.id!, {
          bidderId: resolvedBidderId,
          invoiceNumber: sinv.invoiceNumber,
          subtotal: roundMoney(sinv.subtotal),
          buyersPremiumAmount: roundMoney(sinv.buyersPremiumAmount),
          taxAmount: sinv.taxAmount,
          total: sinv.total,
          status: sinv.status,
          paymentMethod: sinv.paymentMethod,
          paymentDate: sinv.paymentDate ? parseDate(sinv.paymentDate) : undefined,
          generatedAt: parseDate(sinv.generatedAt),
          buyersPremiumRate: sinv.buyersPremiumRate,
          taxRate: sinv.taxRate,
          manualLines: sinv.manualLines,
        });
        summary.invoicesUpdated++;
      }
      if (local.id != null) invoiceIdBySyncKey.set(sk, local.id);
    }
  }

  // --- Sales: match by syncKey ---
  const localSales = await db.sales.where("eventId").equals(eventId).toArray();
  const localSaleBySyncKey = new Map<string, Sale>();
  for (const s of localSales) {
    if (s.syncKey) localSaleBySyncKey.set(s.syncKey, s);
  }

  for (const ss of server.sales) {
    const sk = ss.syncKey || newEntitySyncKey();
    // Resolve lot: legacyLotId -> displayLotNumber -> local id
    const lotDisplay = ss.legacyLotId != null
      ? sLookups.lotDisplayByLegacyId.get(ss.legacyLotId)
      : undefined;
    const lotId = lotDisplay != null ? lotIdByDisplay.get(lotDisplay) : undefined;
    // Resolve bidder: legacyBidderId -> paddleNumber -> local id
    const paddle = ss.legacyBidderId != null
      ? sLookups.bidderPaddleByLegacyId.get(ss.legacyBidderId)
      : undefined;
    const bidderId = paddle != null ? bidderIdByPaddle.get(paddle) : undefined;

    if (lotId == null || bidderId == null) continue;

    // Resolve consignor
    let consignorId: number | undefined;
    if (ss.legacyConsignorId != null) {
      const cNum = sLookups.consignorNumByLegacyId.get(ss.legacyConsignorId);
      if (cNum != null) consignorId = consignorIdByNum.get(cNum);
    }

    // Resolve invoice FK via syncKey
    let invoiceId: number | undefined;
    if (ss.legacyInvoiceId != null) {
      const invSk = sLookups.invoiceSyncKeyByLegacyId.get(ss.legacyInvoiceId);
      if (invSk) invoiceId = invoiceIdBySyncKey.get(invSk);
    }

    const local = localSaleBySyncKey.get(sk);
    if (!local) {
      await db.sales.add({
        eventId,
        lotId,
        bidderId,
        displayLotNumber: ss.displayLotNumber,
        paddleNumber: ss.paddleNumber,
        description: ss.description,
        consignor: ss.consignor,
        ...(consignorId != null ? { consignorId } : {}),
        quantity: ss.quantity,
        amount: roundMoney(ss.amount),
        clerkInitials: ss.clerkInitials,
        createdAt: parseDate(ss.createdAt),
        syncKey: sk,
        ...(invoiceId != null ? { invoiceId } : {}),
      });
      summary.salesAdded++;
    } else if (safeMs(ss.createdAt) > safeMs(local.createdAt)) {
      await db.sales.update(local.id!, {
        lotId,
        bidderId,
        displayLotNumber: ss.displayLotNumber,
        paddleNumber: ss.paddleNumber,
        description: ss.description,
        consignor: ss.consignor,
        ...(consignorId != null ? { consignorId } : {}),
        quantity: ss.quantity,
        amount: roundMoney(ss.amount),
        clerkInitials: ss.clerkInitials,
        createdAt: parseDate(ss.createdAt),
        ...(invoiceId != null ? { invoiceId } : {}),
      });
      summary.salesUpdated++;
    }
  }

  return summary;
}
