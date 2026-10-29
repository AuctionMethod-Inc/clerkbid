import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuctionDB } from "@/lib/db";
import { attachUnallocatedSalesToUnpaidInvoice } from "@/lib/services/invoiceLogic";
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

  it("a sale recorded on this device still queues one invoice.put", async () => {
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
    expect(rows.map((o) => o.opType)).toEqual(["invoice.put"]);
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
    const saleId = await addLocalSale("1", 100, false);
    const sale = (await db.sales.get(saleId))!;
    const body = await saleRowToPutBody(db, sale);
    expect(body?.invoiceSyncKey).toBeNull();
    const event = (await db.events.get(eventId))!;
    const r = await applyRemoteOp(db, event, SYNC_ID, "sale.put", body);
    expect(r.ok).toBe(true);
    expect((await db.sales.get(saleId))?.invoiceId ?? null).toBeNull();
    expect((await db.invoices.get(invoiceId))?.subtotal).toBe(0);
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
