import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuctionDB } from "@/lib/db";
import {
  attachUnallocatedSalesToUnpaidInvoice,
  upsertInvoiceForBidder,
} from "@/lib/services/invoiceLogic";
import { removeSaleFromInvoice } from "@/lib/services/saleInvoiceEdits";
import { applyRemoteOp } from "@/lib/sync/ops/applyRemoteOp";
import { saleRowToPutBody } from "@/lib/sync/ops/enqueueOps";

const SYNC_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let db: AuctionDB;
let eventId: number;
let bidderId: number;
let invoiceId: number;
let prevFlag: string | undefined;

async function outboxCount(): Promise<number> {
  return db.syncOutbox.where("eventSyncId").equals(SYNC_ID).count();
}

beforeEach(async () => {
  prevFlag = process.env.NEXT_PUBLIC_SYNC_OPS;
  process.env.NEXT_PUBLIC_SYNC_OPS = "1";
  db = new AuctionDB(`test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  eventId = (await db.events.add({
    name: "E",
    organizationName: "O",
    taxRate: 0.1,
    buyersPremiumRate: 0.1,
    defaultConsignorCommissionRate: 0,
    currencySymbol: "$",
    syncId: SYNC_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as number;
  bidderId = (await db.bidders.add({
    eventId,
    paddleNumber: 4,
    firstName: "A",
    lastName: "K",
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as number;
  for (const n of ["1", "2"]) {
    await db.lots.add({
      eventId,
      baseLotNumber: Number(n),
      lotSuffix: "",
      displayLotNumber: n,
      description: `Lot ${n}`,
      quantity: 1,
      status: "sold",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  invoiceId = (await db.invoices.add({
    eventId,
    bidderId,
    invoiceNumber: "1-001",
    subtotal: 0,
    buyersPremiumAmount: 0,
    taxAmount: 0,
    total: 0,
    status: "unpaid",
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
    syncKey: "inv-1",
  })) as number;
});

afterEach(async () => {
  if (prevFlag === undefined) delete process.env.NEXT_PUBLIC_SYNC_OPS;
  else process.env.NEXT_PUBLIC_SYNC_OPS = prevFlag;
  db.close();
  await Dexie.delete(db.name);
});

function salePutBody(overrides?: Record<string, unknown>) {
  return {
    saleSyncKey: "sale-remote-1",
    displayLotNumber: "1",
    paddleNumber: 4,
    description: "Lot 1",
    quantity: 1,
    amount: 100,
    clerkInitials: "DW",
    createdAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("applyRemoteOp sale.put (#43)", () => {
  it("attaches a new remote sale to the unpaid invoice without queuing an invoice.put", async () => {
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(db, event, SYNC_ID, "sale.put", salePutBody());
    expect(r.ok).toBe(true);
    const sale = await db.sales
      .where("eventId")
      .equals(eventId)
      .filter((s) => s.syncKey === "sale-remote-1")
      .first();
    expect(sale?.invoiceId).toBe(invoiceId);
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(100);
    expect(await outboxCount()).toBe(0);
  });

  it("updating an existing remote sale does not queue an invoice.put either", async () => {
    const event = (await db.events.get(eventId))!;
    await applyRemoteOp(db, event, SYNC_ID, "sale.put", salePutBody());
    const r = await applyRemoteOp(
      db,
      event,
      SYNC_ID,
      "sale.put",
      salePutBody({ amount: 150, invoiceSyncKey: "inv-1" })
    );
    expect(r.ok).toBe(true);
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(150);
    expect(await outboxCount()).toBe(0);
  });

  it("a sale recorded on this device queues one invoice.put, then its sale.put", async () => {
    const lotId = (await db.lots
      .where("eventId")
      .equals(eventId)
      .filter((l) => l.displayLotNumber === "2")
      .first())!.id!;
    await db.sales.add({
      eventId,
      lotId,
      bidderId,
      displayLotNumber: "2",
      paddleNumber: 4,
      description: "Lot 2",
      quantity: 1,
      amount: 50,
      clerkInitials: "DW",
      createdAt: new Date(),
    });
    const event = (await db.events.get(eventId))!;
    const r = await attachUnallocatedSalesToUnpaidInvoice(db, event, bidderId);
    expect(r?.kind).toBe("updated");
    const rows = await db.syncOutbox.where("eventSyncId").equals(SYNC_ID).toArray();
    expect(rows.map((o) => o.opType)).toEqual(["invoice.put", "sale.put"]);
  });
});

async function addLocalSale(lot: string, amount: number, onInvoice: boolean) {
  const lotId = (await db.lots
    .where("eventId")
    .equals(eventId)
    .filter((l) => l.displayLotNumber === lot)
    .first())!.id!;
  return (await db.sales.add({
    eventId,
    lotId,
    bidderId,
    displayLotNumber: lot,
    paddleNumber: 4,
    description: `Lot ${lot}`,
    quantity: 1,
    amount,
    clerkInitials: "DW",
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    syncKey: `sale-local-${lot}`,
    ...(onInvoice ? { invoiceId } : {}),
  })) as number;
}

describe("removed invoice lines stay removed (#84)", () => {
  it("a removed line stays off after its own sale.put echoes back", async () => {
    const saleId = await addLocalSale("1", 100, true);
    const event = (await db.events.get(eventId))!;
    await removeSaleFromInvoice(db, event, saleId, invoiceId);
    const op = await db.syncOutbox
      .where("eventSyncId")
      .equals(SYNC_ID)
      .filter((o) => o.opType === "sale.put")
      .first();
    const body = op!.body as { invoiceSyncKey?: string | null };
    expect(body.invoiceSyncKey).toBeNull();
    const r = await applyRemoteOp(db, event, SYNC_ID, "sale.put", body);
    expect(r.ok).toBe(true);
    expect((await db.sales.get(saleId))?.invoiceId ?? null).toBeNull();
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(0);
  });

  it("an edit to a sale on no invoice leaves the invoice key out", async () => {
    const saleId = await addLocalSale("1", 100, false);
    const body = await saleRowToPutBody(db, (await db.sales.get(saleId))!);
    expect(body).not.toBeNull();
    expect(body?.invoiceSyncKey).toBeUndefined();
  });

  it("a stale edit from a device that has the line on no invoice does not take it off", async () => {
    const saleId = await addLocalSale("1", 100, true);
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(
      db,
      event,
      SYNC_ID,
      "sale.put",
      salePutBody({ saleSyncKey: "sale-local-1", description: "Lot 1 fixed" })
    );
    expect(r.ok).toBe(true);
    const sale = await db.sales.get(saleId);
    expect(sale?.invoiceId).toBe(invoiceId);
    expect(sale?.description).toBe("Lot 1 fixed");
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(100);
  });

  it("a removal never takes a line off an invoice that is paid on this device", async () => {
    const saleId = await addLocalSale("1", 100, true);
    await db.invoices.update(invoiceId, { status: "paid", subtotal: 100, total: 121 });
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(
      db,
      event,
      SYNC_ID,
      "sale.put",
      salePutBody({ saleSyncKey: "sale-local-1", invoiceSyncKey: null })
    );
    expect(r.ok).toBe(true);
    expect((await db.sales.get(saleId))?.invoiceId).toBe(invoiceId);
    expect((await db.invoices.get(invoiceId))?.total).toBe(121);
  });

  it("an invoice key this device does not have leaves the line where it is", async () => {
    const saleId = await addLocalSale("1", 100, false);
    const secondId = (await db.invoices.add({
      eventId,
      bidderId,
      invoiceNumber: "1-002",
      subtotal: 100,
      buyersPremiumAmount: 0,
      taxAmount: 0,
      total: 100,
      status: "unpaid",
      generatedAt: new Date("2026-01-01T00:00:00.000Z"),
      syncKey: "inv-2",
    })) as number;
    await db.sales.update(saleId, { invoiceId: secondId });
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(
      db,
      event,
      SYNC_ID,
      "sale.put",
      salePutBody({ saleSyncKey: "sale-local-1", invoiceSyncKey: "inv-unknown" })
    );
    expect(r.ok).toBe(true);
    expect((await db.sales.get(saleId))?.invoiceId).toBe(secondId);
  });

  it("a removed line stays off when another sale for the bidder arrives", async () => {
    const removedId = await addLocalSale("2", 50, false);
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(
      db,
      event,
      SYNC_ID,
      "sale.put",
      salePutBody({ invoiceSyncKey: "inv-1" })
    );
    expect(r.ok).toBe(true);
    expect((await db.sales.get(removedId))?.invoiceId ?? null).toBeNull();
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(100);
  });

  it("a removal from another device takes the line off this device's invoice", async () => {
    const saleId = await addLocalSale("1", 100, true);
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(
      db,
      event,
      SYNC_ID,
      "sale.put",
      salePutBody({ saleSyncKey: "sale-local-1", invoiceSyncKey: null })
    );
    expect(r.ok).toBe(true);
    expect((await db.sales.get(saleId))?.invoiceId ?? null).toBeNull();
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(0);
  });

  it("a new remote sale with no invoice key still joins the open invoice", async () => {
    const removedId = await addLocalSale("2", 50, false);
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(db, event, SYNC_ID, "sale.put", salePutBody());
    expect(r.ok).toBe(true);
    const sale = await db.sales
      .where("eventId")
      .equals(eventId)
      .filter((s) => s.syncKey === "sale-remote-1")
      .first();
    expect(sale?.invoiceId).toBe(invoiceId);
    expect((await db.sales.get(removedId))?.invoiceId ?? null).toBeNull();
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(100);
  });

  it("a sale on an invoice sends that invoice's key", async () => {
    const saleId = await addLocalSale("1", 100, true);
    const body = await saleRowToPutBody(db, (await db.sales.get(saleId))!);
    expect(body?.invoiceSyncKey).toBe("inv-1");
  });
});

async function seedOtherDevice(): Promise<{ other: AuctionDB; otherEventId: number }> {
  const other = new AuctionDB(`test_b_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const ev = (await db.events.get(eventId))!;
  const { id: _e, ...evRow } = ev;
  const otherEventId = (await other.events.add(evRow)) as number;
  const b = (await db.bidders.get(bidderId))!;
  const { id: _b, ...bRow } = b;
  const otherBidderId = (await other.bidders.add({ ...bRow, eventId: otherEventId })) as number;
  for (const l of await db.lots.where("eventId").equals(eventId).toArray()) {
    const { id: _l, ...lRow } = l;
    const lotId = (await other.lots.add({ ...lRow, eventId: otherEventId })) as number;
    const sale = await db.sales
      .where("eventId")
      .equals(eventId)
      .filter((x) => x.lotId === l.id)
      .first();
    if (sale) {
      const { id: _s, invoiceId: _i, ...sRow } = sale;
      await other.sales.add({
        ...sRow,
        eventId: otherEventId,
        lotId,
        bidderId: otherBidderId,
      });
    }
  }
  return { other, otherEventId };
}

async function replayOutboxOn(other: AuctionDB, otherEventId: number) {
  const ops = await db.syncOutbox.where("eventSyncId").equals(SYNC_ID).sortBy("id");
  const otherEvent = (await other.events.get(otherEventId))!;
  for (const op of ops) {
    const r = await applyRemoteOp(other, otherEvent, SYNC_ID, op.opType, op.body);
    expect(r.ok).toBe(true);
  }
  return ops.map((o) => o.opType);
}

describe("lines Generate links reach other devices (#84)", () => {
  it("auto-attach queues a sale.put per linked line, and the other device links them", async () => {
    await addLocalSale("1", 100, false);
    await addLocalSale("2", 50, false);
    const { other, otherEventId } = await seedOtherDevice();
    try {
      const event = (await db.events.get(eventId))!;
      await attachUnallocatedSalesToUnpaidInvoice(db, event, bidderId);
      // The other device already has the invoice from an earlier invoice.put.
      const { id: _id, ...invRow } = (await db.invoices.get(invoiceId))!;
      const otherBidder = (await other.bidders.toArray())[0]!;
      await other.invoices.add({
        ...invRow,
        eventId: otherEventId,
        bidderId: otherBidder.id!,
        subtotal: 0,
        total: 0,
      });
      const types = await replayOutboxOn(other, otherEventId);
      expect(types).toEqual(["invoice.put", "sale.put", "sale.put"]);
      const otherInv = (await other.invoices.toArray())[0]!;
      const linked = await other.sales.where("invoiceId").equals(otherInv.id!).toArray();
      expect(linked.map((x) => x.syncKey).sort()).toEqual(["sale-local-1", "sale-local-2"]);
      expect(otherInv.subtotal).toBe(150);
    } finally {
      other.close();
      await Dexie.delete(other.name);
    }
  });

  it("Generate on a new invoice links the same lines on the other device", async () => {
    await db.invoices.delete(invoiceId);
    await addLocalSale("1", 100, false);
    await addLocalSale("2", 50, false);
    const { other, otherEventId } = await seedOtherDevice();
    try {
      const event = (await db.events.get(eventId))!;
      const r = await upsertInvoiceForBidder(db, event, bidderId);
      expect(r.kind).toBe("created");
      const types = await replayOutboxOn(other, otherEventId);
      expect(types).toEqual(["invoice.put", "sale.put", "sale.put"]);
      const otherInvs = await other.invoices.toArray();
      expect(otherInvs).toHaveLength(1);
      const linked = await other.sales.where("invoiceId").equals(otherInvs[0]!.id!).toArray();
      expect(linked).toHaveLength(2);
      expect(otherInvs[0]!.subtotal).toBe(150);
    } finally {
      other.close();
      await Dexie.delete(other.name);
    }
  });
});
