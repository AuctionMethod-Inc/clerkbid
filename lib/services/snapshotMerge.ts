import type { AuctionDB, Bidder, Consignor, Invoice, Lot, Sale } from "@/lib/db";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";
import { newEntitySyncKey } from "@/lib/utils/clientSyncKey";
import { toDate } from "@/lib/utils/coerceDate";
import type { EventExportPayload } from "@/lib/services/dataPorter";
import { computeInvoiceTotalsFromParts, roundMoney } from "@/lib/services/invoiceLogic";

function safeMs(d: Date | string | number | undefined | null): number {
  const parsed = toDate(d);
  return parsed ? parsed.getTime() : 0;
}

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

/**
 * True when local event data may not yet be reflected on the server snapshot,
 * so a full replace would drop recent bidders/sales/etc.
 * - After a successful snapshot push: `updatedAt` vs `lastCloudPushAt`.
 * - If we have never snapshot-pushed: `updatedAt` vs `lastCloudPullAt` (requires
 *   post-pull `events.updatedAt` to match server snapshot time — see refresh paths).
 */
export function hasUnpushedLocalEventMetadataEdits(ev: {
  updatedAt: Date;
  lastCloudPushAt?: Date;
  lastCloudPullAt?: Date;
}): boolean {
  const u = ev.updatedAt.getTime();
  if (ev.lastCloudPushAt != null && u > ev.lastCloudPushAt.getTime()) {
    return true;
  }
  if (ev.lastCloudPullAt != null && u > ev.lastCloudPullAt.getTime()) {
    return true;
  }
  return false;
}

/**
 * True when nothing was written here since the last save or download:
 * `updatedAt` still holds the server time that save or download set. Compares
 * two server-clock values, so a device clock that runs behind cannot make an
 * edit look saved.
 */
export function eventUnchangedSinceLastCloudSync(ev: {
  updatedAt: Date;
  lastCloudPullAt?: Date;
}): boolean {
  return (
    ev.lastCloudPullAt != null &&
    ev.updatedAt.getTime() === ev.lastCloudPullAt.getTime()
  );
}

/**
 * A refresh skips its deletions when a row it would delete was written on this
 * device this recently: the row may be new here and not yet marked unsaved.
 */
export const RECENT_LOCAL_WRITE_MS = 5_000;

type PaymentFields = Pick<Invoice, "status" | "paymentMethod" | "paymentDate">;

function paymentFieldsEqual(
  a: PaymentFields,
  b: { status: string; paymentMethod?: string; paymentDate?: Date | string }
): boolean {
  return (
    a.status === b.status &&
    (a.paymentMethod ?? undefined) === (b.paymentMethod ?? undefined) &&
    safeMs(a.paymentDate) === safeMs(b.paymentDate)
  );
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
  /** Rows removed because the cloud copy no longer has them (refresh only). */
  rowsRemoved: number;
  /** A refresh found rows to remove but skipped it (a row was written here just now). */
  removalsDeferred: boolean;
};

export type MergeOptions = {
  /**
   * Leave this device's event settings (name, rates, currency, description)
   * alone. For the merge after a refused save, where the device has unsaved
   * edits and the retry save would otherwise undo a settings change made here.
   */
  keepLocalEventSettings?: boolean;
  /**
   * Add a server row this device does not have only if it was created after
   * this time (this device's last cloud sync). An older row missing locally
   * was deleted here, so it stays deleted. For the merge after a refused
   * save; leave unset to add every missing row (refresh).
   */
  addMissingRowsCreatedAfter?: Date;
  /**
   * The cloud version this device last saved or downloaded. For the merge
   * after a refused save: an invoice whose status and payment still match it
   * was not changed here, so the cloud's status and payment are taken; one
   * that differs was changed here and keeps this device's. Links work the same
   * way, one at a time (a sale's lot, bidder, consignor and invoice; a lot's
   * consignor): a link that still matches it takes the cloud's, one that
   * differs was changed here and stays.
   */
  localBase?: EventExportPayload;
  /**
   * Refresh from a newer cloud copy saved at this time. If the device has no
   * unsaved edits and no pending outbox (checked inside the merge
   * transaction), the cloud copy is authoritative: rows it no longer has are
   * removed and its invoices are taken as they are. Also records the pull on
   * the event, unless removals were deferred, so the refresh runs again.
   */
  refreshPulledAt?: Date;
  /** Clock for the recent-write check (tests). */
  now?: Date;
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
  serverPayload: EventExportPayload,
  options: MergeOptions = {}
): Promise<MergeSummary> {
  return withCloudSyncApply(() =>
    db.transaction(
      "rw",
      [
        db.events,
        db.bidders,
        db.consignors,
        db.lots,
        db.sales,
        db.invoices,
        db.syncOutbox,
      ],
      () => mergeImpl(db, eventId, serverPayload, options)
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
  server: EventExportPayload,
  options: MergeOptions
): Promise<MergeSummary> {
  const summary: MergeSummary = {
    biddersAdded: 0, biddersUpdated: 0,
    consignorsAdded: 0, consignorsUpdated: 0,
    lotsAdded: 0, lotsUpdated: 0,
    salesAdded: 0, salesUpdated: 0,
    invoicesAdded: 0, invoicesUpdated: 0,
    rowsRemoved: 0, removalsDeferred: false,
  };

  const event = await db.events.get(eventId);
  if (!event) throw new Error("Event not found for merge");

  // Checked in this transaction so an edit cannot land between check and merge.
  const syncId = event.syncId?.trim();
  const pendingOutbox = syncId
    ? await db.syncOutbox.where("eventSyncId").equals(syncId).count()
    : 0;
  // A refresh of a device with nothing unsaved takes the cloud's links.
  const linksAuthoritative =
    options.refreshPulledAt != null &&
    eventUnchangedSinceLastCloudSync(event) &&
    pendingOutbox === 0;
  // Removals and the cloud's invoices as they are also need a stored cloud
  // copy: without one (first refresh after the upgrade), the "unchanged"
  // marker may have been set by the old refresh, which marked the event saved
  // even with unsaved rows, so it is not trusted for those.
  const serverAuthoritative = linksAuthoritative && options.localBase != null;
  const baseInvoiceBySyncKey = new Map<string, EventExportPayload["invoices"][number]>();
  for (const inv of options.localBase?.invoices ?? []) {
    if (inv.syncKey) baseInvoiceBySyncKey.set(inv.syncKey, inv);
  }
  const baseLookups = options.localBase ? buildServerLookups(options.localBase) : null;
  const baseSaleBySyncKey = new Map<string, EventExportPayload["sales"][number]>();
  for (const s of options.localBase?.sales ?? []) {
    if (s.syncKey) baseSaleBySyncKey.set(s.syncKey, s);
  }
  const baseLotByDisplay = new Map<string, EventExportPayload["lots"][number]>();
  for (const l of options.localBase?.lots ?? []) baseLotByDisplay.set(l.displayLotNumber, l);
  const sLookups = buildServerLookups(server);
  const cloudKeysOf = <K>(map: Map<number, K>) => new Set<unknown>(Array.from(map.values()));
  const cloudPaddles = cloudKeysOf(sLookups.bidderPaddleByLegacyId);
  const cloudConsignorNums = cloudKeysOf(sLookups.consignorNumByLegacyId);
  const cloudLotDisplays = cloudKeysOf(sLookups.lotDisplayByLegacyId);
  const cloudInvoiceKeys = cloudKeysOf(sLookups.invoiceSyncKeyByLegacyId);
  /**
   * Take the cloud's value for one link: on a refresh of a device with nothing
   * unsaved; otherwise only when this device's link (as a natural key) still
   * matches the last cloud copy it had, so it was not changed here. Without
   * that copy the "unchanged" marker may be the old refresh's, so a link to a
   * record the cloud does not have (likely unsaved here) stays.
   */
  const takeCloudLink = (
    hasBaseRow: boolean,
    localKey: unknown,
    baseKey: unknown,
    cloudKeys: Set<unknown>
  ): boolean =>
    (linksAuthoritative &&
      (options.localBase != null || localKey === null || cloudKeys.has(localKey))) ||
    (hasBaseRow && localKey === baseKey);
  // Invoices a sale moved on or off while the cloud's invoice rows were not
  // taken as they are: their totals are recomputed after the sales merge.
  const invoicesToRecount = new Set<number>();
  const noteInvoiceMove = (from: number | undefined, to: number | undefined) => {
    if (serverAuthoritative || from === to) return;
    if (from != null) invoicesToRecount.add(from);
    if (to != null) invoicesToRecount.add(to);
  };
  const addedAfterMs = options.addMissingRowsCreatedAfter?.getTime();
  const mayAddMissing = (createdAt: string | undefined): boolean =>
    addedAfterMs == null || safeMs(createdAt) > addedAfterMs;

  // --- Merge event-level metadata (server wins for config fields) ---
  const sev = server.event;
  if (!options.keepLocalEventSettings) await db.events.update(eventId, {
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
      if (!mayAddMissing(sb.createdAt)) continue;
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
      if (!mayAddMissing(sc.createdAt)) continue;
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
  const consignorNumById = new Map<number, number>();
  for (const [num, id] of Array.from(consignorIdByNum.entries())) consignorNumById.set(id, num);

  for (const sl of server.lots) {
    const local = localLotByDisplay.get(sl.displayLotNumber);
    // Resolve consignorId: legacyConsignorId -> consignorNumber (via server lookup) -> local id
    let consignorId: number | undefined;
    if (sl.legacyConsignorId != null) {
      const cNum = sLookups.consignorNumByLegacyId.get(sl.legacyConsignorId);
      if (cNum != null) consignorId = consignorIdByNum.get(cNum);
    }
    const baseLot = baseLotByDisplay.get(sl.displayLotNumber);
    const takeConsignorLink =
      local != null &&
      takeCloudLink(
        baseLot != null,
        consignorNumById.get(local.consignorId ?? -1) ?? null,
        baseLot && baseLookups
          ? baseLookups.consignorNumByLegacyId.get(baseLot.legacyConsignorId ?? -1) ?? null
          : null,
        cloudConsignorNums
      );

    if (!local) {
      if (!mayAddMissing(sl.createdAt)) continue;
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
      // With no cloud copy to compare against, the newer row's link wins as before.
      const takeLink = takeConsignorLink || (!options.localBase && consignorId != null);
      await db.lots.update(local.id!, {
        baseLotNumber: sl.baseLotNumber,
        lotSuffix: sl.lotSuffix,
        description: sl.description,
        // The consignor name moves with the link, so a link kept here keeps its name.
        ...(takeLink || !options.localBase ? { consignor: sl.consignor } : {}),
        ...(takeLink ? { consignorId } : {}),
        notes: sl.notes,
        quantity: sl.quantity,
        status: sl.status,
        updatedAt: parseDate(sl.updatedAt),
      });
      summary.lotsUpdated++;
    } else if (takeConsignorLink && (local.consignorId ?? undefined) !== consignorId) {
      // A link-only change may leave the lot's edit time as it was.
      await db.lots.update(local.id!, { consignorId, consignor: sl.consignor });
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
      if (!mayAddMissing(sinv.generatedAt)) continue;
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
      const base = baseInvoiceBySyncKey.get(sk);
      if (
        (serverAuthoritative ||
          safeMs(sinv.generatedAt) > safeMs(local.generatedAt)) &&
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
      } else if (
        base &&
        paymentFieldsEqual(local, base) &&
        !paymentFieldsEqual(local, sinv)
      ) {
        // Not paid or unpaid here since the last sync: take the cloud's payment.
        await db.invoices.update(local.id!, {
          status: sinv.status,
          paymentMethod: sinv.paymentMethod,
          paymentDate: sinv.paymentDate ? parseDate(sinv.paymentDate) : undefined,
        });
        summary.invoicesUpdated++;
      }
      if (local.id != null) invoiceIdBySyncKey.set(sk, local.id);
    }
  }

  // --- Sales: match by syncKey ---
  const paddleByBidderId = new Map<number, number>();
  for (const [paddle, id] of Array.from(bidderIdByPaddle.entries())) paddleByBidderId.set(id, paddle);
  const lotDisplayById = new Map<number, string>();
  for (const [display, id] of Array.from(lotIdByDisplay.entries())) lotDisplayById.set(id, display);
  const invoiceSyncKeyById = new Map<number, string>();
  for (const [sk, id] of Array.from(invoiceIdBySyncKey.entries())) invoiceSyncKeyById.set(id, sk);
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
      if (!mayAddMissing(ss.createdAt)) continue;
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
    } else if (
      safeMs(ss.createdAt) > safeMs(local.createdAt) ||
      // A bidder or lot renumbered elsewhere: point the sale at the cloud's
      // row before the old one is removed.
      (serverAuthoritative && (local.bidderId !== bidderId || local.lotId !== lotId))
    ) {
      if (invoiceId != null || linksAuthoritative) {
        noteInvoiceMove(local.invoiceId ?? undefined, invoiceId);
      }
      await db.sales.update(local.id!, {
        lotId,
        bidderId,
        displayLotNumber: ss.displayLotNumber,
        paddleNumber: ss.paddleNumber,
        description: ss.description,
        consignor: ss.consignor,
        // An authoritative cloud copy also clears links it does not have.
        ...(consignorId != null || linksAuthoritative ? { consignorId } : {}),
        quantity: ss.quantity,
        amount: roundMoney(ss.amount),
        clerkInitials: ss.clerkInitials,
        createdAt: parseDate(ss.createdAt),
        ...(invoiceId != null || linksAuthoritative ? { invoiceId } : {}),
      });
      summary.salesUpdated++;
    } else {
      // Sales have no edit time, so a link-only change never looks newer:
      // decide each link against the last cloud copy this device had.
      const base = baseSaleBySyncKey.get(sk);
      const baseKey = <K>(legacyId: number | undefined, map: Map<number, K> | undefined) =>
        legacyId != null ? map?.get(legacyId) ?? null : null;
      const take = (localKey: unknown, baseValue: unknown, cloudKeys: Set<unknown>) =>
        takeCloudLink(base != null, localKey, baseValue, cloudKeys);
      const patch: Partial<Sale> = {};
      // A sale carries copies of its lot number, paddle number and consignor
      // name next to the ids; move them with the id so the row stays consistent.
      if (
        local.lotId !== lotId &&
        take(
          lotDisplayById.get(local.lotId) ?? null,
          baseKey(base?.legacyLotId, baseLookups?.lotDisplayByLegacyId),
          cloudLotDisplays
        )
      ) {
        patch.lotId = lotId;
        patch.displayLotNumber = ss.displayLotNumber;
      }
      if (
        local.bidderId !== bidderId &&
        take(
          paddleByBidderId.get(local.bidderId) ?? null,
          baseKey(base?.legacyBidderId, baseLookups?.bidderPaddleByLegacyId),
          cloudPaddles
        )
      ) {
        patch.bidderId = bidderId;
        patch.paddleNumber = ss.paddleNumber;
      }
      if (
        (local.consignorId ?? undefined) !== consignorId &&
        take(
          consignorNumById.get(local.consignorId ?? -1) ?? null,
          baseKey(base?.legacyConsignorId, baseLookups?.consignorNumByLegacyId),
          cloudConsignorNums
        )
      ) {
        patch.consignorId = consignorId;
        patch.consignor = ss.consignor;
      }
      if (
        (local.invoiceId ?? undefined) !== invoiceId &&
        take(
          invoiceSyncKeyById.get(local.invoiceId ?? -1) ?? null,
          baseKey(base?.legacyInvoiceId, baseLookups?.invoiceSyncKeyByLegacyId),
          cloudInvoiceKeys
        )
      ) {
        patch.invoiceId = invoiceId;
        noteInvoiceMove(local.invoiceId ?? undefined, invoiceId);
      }
      if (Object.keys(patch).length > 0) {
        await db.sales.update(local.id!, patch);
        summary.salesUpdated++;
      }
    }
  }

  if (invoicesToRecount.size > 0) {
    // Same totals as recalculateAndPersistInvoice, written in this transaction.
    const mergedEvent = (await db.events.get(eventId))!;
    for (const id of Array.from(invoicesToRecount)) {
      const inv = await db.invoices.get(id);
      if (inv?.id == null || inv.status === "paid") continue;
      const lineSales = await db.sales.where("invoiceId").equals(id).toArray();
      const parts = computeInvoiceTotalsFromParts(
        roundMoney(lineSales.reduce((a, s) => a + s.amount, 0)),
        inv.manualLines,
        inv,
        mergedEvent
      );
      await db.invoices.update(id, parts);
    }
  }

  if (serverAuthoritative) {
    await removeRowsMissingFromServer(db, eventId, server, summary, options.now ?? new Date());
  }
  if (options.refreshPulledAt != null && !summary.removalsDeferred) {
    const pulledAt = options.refreshPulledAt;
    await db.events.update(eventId, {
      lastCloudPullAt: pulledAt,
      // With unsaved edits, stay marked unsaved so the next cycle saves them
      // before a refresh can treat their rows as deleted in the cloud.
      updatedAt: serverAuthoritative
        ? pulledAt
        : new Date(Math.max(event.updatedAt.getTime(), pulledAt.getTime()) + 1),
    });
  }

  return summary;
}

function lastLocalWriteMs(row: {
  createdAt?: Date;
  updatedAt?: Date;
  generatedAt?: Date;
}): number {
  return Math.max(safeMs(row.createdAt), safeMs(row.updatedAt), safeMs(row.generatedAt));
}

/**
 * Remove local rows the cloud copy no longer has (deleted on another device).
 * Only for a refresh on a device with no unsaved edits. Skipped as a whole if
 * any of those rows was written here in the last few seconds.
 */
async function removeRowsMissingFromServer(
  db: AuctionDB,
  eventId: number,
  server: EventExportPayload,
  summary: MergeSummary,
  now: Date
): Promise<void> {
  const paddles = new Set(server.bidders.map((b) => b.paddleNumber));
  const consignorNums = new Set((server.consignors ?? []).map((c) => c.consignorNumber));
  const lotDisplays = new Set(server.lots.map((l) => l.displayLotNumber));
  // Rows exported without a sync key get a new one on every merge, so they
  // can't be matched; leave that table alone.
  const saleKeys = server.sales.every((s) => s.syncKey)
    ? new Set(server.sales.map((s) => s.syncKey))
    : null;
  const invoiceKeys = server.invoices.every((i) => i.syncKey)
    ? new Set(server.invoices.map((i) => i.syncKey))
    : null;

  const allSales = await db.sales.where("eventId").equals(eventId).toArray();
  const allInvoices = await db.invoices.where("eventId").equals(eventId).toArray();
  const sales = saleKeys
    ? allSales.filter((s) => s.syncKey && !saleKeys.has(s.syncKey))
    : [];
  const invoices = invoiceKeys
    ? allInvoices.filter((i) => i.syncKey && !invoiceKeys.has(i.syncKey))
    : [];
  // A bidder or lot that a kept sale or invoice still points at stays, so no
  // row is left pointing at a deleted one.
  const goneSales = new Set(sales);
  const goneInvoices = new Set(invoices);
  const keptBidderIds = new Set<number>();
  const keptLotIds = new Set<number>();
  for (const s of allSales) {
    if (goneSales.has(s)) continue;
    keptBidderIds.add(s.bidderId);
    keptLotIds.add(s.lotId);
  }
  for (const i of allInvoices) {
    if (!goneInvoices.has(i)) keptBidderIds.add(i.bidderId);
  }

  const bidders = (await db.bidders.where("eventId").equals(eventId).toArray())
    .filter((b) => !paddles.has(b.paddleNumber) && !keptBidderIds.has(b.id!));
  const consignors = (await db.consignors.where("eventId").equals(eventId).toArray())
    .filter((c) => !consignorNums.has(c.consignorNumber));
  const lots = (await db.lots.where("eventId").equals(eventId).toArray())
    .filter((l) => !lotDisplays.has(l.displayLotNumber) && !keptLotIds.has(l.id!));

  const all = [...bidders, ...consignors, ...lots, ...sales, ...invoices];
  if (all.length === 0) return;
  const recentCutoff = now.getTime() - RECENT_LOCAL_WRITE_MS;
  // A time in this device's future was copied from a device whose clock runs
  // ahead, so it is not a write made here.
  const writtenHereJustNow = (row: Parameters<typeof lastLocalWriteMs>[0]) => {
    const t = lastLocalWriteMs(row);
    return t > recentCutoff && t <= now.getTime();
  };
  if (all.some(writtenHereJustNow)) {
    summary.removalsDeferred = true;
    return;
  }

  const ids = (rows: Array<{ id?: number }>) =>
    rows.map((r) => r.id).filter((id): id is number => id != null);
  await db.bidders.bulkDelete(ids(bidders));
  await db.consignors.bulkDelete(ids(consignors));
  await db.lots.bulkDelete(ids(lots));
  await db.sales.bulkDelete(ids(sales));
  await db.invoices.bulkDelete(ids(invoices));
  summary.rowsRemoved = all.length;

  // Lines left on a removed invoice go back to unallocated; lots and sales of
  // a removed consignor lose the link.
  const goneInvoiceIds = new Set(ids(invoices));
  const goneConsignorIds = new Set(ids(consignors));
  if (goneInvoiceIds.size > 0 || goneConsignorIds.size > 0) {
    await db.sales.where("eventId").equals(eventId).modify((s: Sale) => {
      if (s.invoiceId != null && goneInvoiceIds.has(s.invoiceId)) s.invoiceId = null;
      if (s.consignorId != null && goneConsignorIds.has(s.consignorId)) delete s.consignorId;
    });
  }
  if (goneConsignorIds.size > 0) {
    await db.lots.where("eventId").equals(eventId).modify((l: Lot) => {
      if (l.consignorId != null && goneConsignorIds.has(l.consignorId)) delete l.consignorId;
    });
  }
}
