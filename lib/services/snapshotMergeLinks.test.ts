import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import {
  buildEventExport,
  EXPORT_VERSION,
  importEventFromPayload,
  type EventExportPayload,
} from "@/lib/services/dataPorter";
import { mergeServerSnapshotIntoLocal } from "@/lib/services/snapshotMerge";
import { eventSnapshotsContentEqual } from "@/lib/services/snapshotContentEqual";

const SYNC_ID = "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee";
const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-02T00:00:00.000Z");

type Device = { db: AuctionDB; eventId: number };
const devices: Device[] = [];

/** Same event on every device: one bidder, two invoices, a lot, two consignors, one sale. */
async function seedDevice(): Promise<Device> {
  const db = new AuctionDB(`links_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const eventId = (await db.events.add({
    name: "Test Auction",
    organizationName: "Test Org",
    taxRate: 0.08,
    buyersPremiumRate: 0.1,
    defaultConsignorCommissionRate: 0.15,
    currencySymbol: "$",
    syncId: SYNC_ID,
    createdAt: T0,
    updatedAt: T0,
  })) as number;
  const bidderId = (await db.bidders.add({
    eventId,
    paddleNumber: 1,
    firstName: "Alice",
    lastName: "Smith",
    createdAt: T0,
    updatedAt: T0,
  })) as number;
  for (const n of [7, 8]) {
    await db.consignors.add({
      eventId,
      consignorNumber: n,
      name: `Seller ${n}`,
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const lotId = (await db.lots.add({
    eventId,
    baseLotNumber: 1,
    lotSuffix: "",
    displayLotNumber: "1",
    description: "Chair",
    quantity: 1,
    status: "sold",
    createdAt: T0,
    updatedAt: T0,
  })) as number;
  const invoice = (syncKey: string, invoiceNumber: string) => ({
    eventId,
    bidderId,
    invoiceNumber,
    subtotal: 0,
    buyersPremiumAmount: 0,
    taxAmount: 0,
    total: 0,
    status: "unpaid" as const,
    generatedAt: T0,
    syncKey,
  });
  const invA = (await db.invoices.add(invoice("inv-a", "1-001"))) as number;
  await db.invoices.add(invoice("inv-b", "1-002"));
  await db.sales.add({
    eventId,
    lotId,
    bidderId,
    displayLotNumber: "1",
    paddleNumber: 1,
    description: "Chair",
    quantity: 1,
    amount: 50,
    clerkInitials: "AB",
    createdAt: T0,
    syncKey: "sale-1",
    invoiceId: invA,
  });
  const d = { db, eventId };
  devices.push(d);
  return d;
}

async function invoiceId(d: Device, syncKey: string): Promise<number> {
  const inv = await d.db.invoices.where("eventId").equals(d.eventId).filter((i) => i.syncKey === syncKey).first();
  return inv!.id!;
}

async function theSale(d: Device) {
  return (await d.db.sales.where("eventId").equals(d.eventId).toArray())[0]!;
}

async function theLot(d: Device) {
  return (await d.db.lots.where("eventId").equals(d.eventId).toArray())[0]!;
}

async function consignorId(d: Device, n: number): Promise<number> {
  const c = await d.db.consignors.where("eventId").equals(d.eventId).filter((x) => x.consignorNumber === n).first();
  return c!.id!;
}

afterEach(async () => {
  for (const d of devices.splice(0)) {
    d.db.close();
    await Dexie.delete(d.db.name);
  }
});

describe("a merge takes the cloud's links unless this device changed them (#42)", () => {
  let a: Device;
  let b: Device;
  /** The cloud copy both devices last had: the seed. */
  let base: EventExportPayload;
  beforeEach(async () => {
    a = await seedDevice();
    b = await seedDevice();
    base = await buildEventExport(b.db, b.eventId);
  });

  it("a sale moved to another invoice on A shows on B, and B's next push compares unchanged", async () => {
    await a.db.sales.update((await theSale(a)).id!, {
      invoiceId: await invoiceId(a, "inv-b"),
    });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, { localBase: base });

    expect((await theSale(b)).invoiceId).toBe(await invoiceId(b, "inv-b"));
    expect(
      eventSnapshotsContentEqual(cloud, await buildEventExport(b.db, b.eventId))
    ).toBe(true);
  });

  it("a $0 line removed from its invoice on A is cleared on B", async () => {
    await a.db.sales.update((await theSale(a)).id!, { invoiceId: undefined });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, { localBase: base });

    expect((await theSale(b)).invoiceId ?? null).toBeNull();
    expect(
      eventSnapshotsContentEqual(cloud, await buildEventExport(b.db, b.eventId))
    ).toBe(true);
  });

  it("a sale's consignor set and then changed on A reaches B", async () => {
    await a.db.sales.update((await theSale(a)).id!, {
      consignorId: await consignorId(a, 8),
    });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, { localBase: base });

    expect((await theSale(b)).consignorId).toBe(await consignorId(b, 8));
  });

  it("a lot linked to a consignor on A shows on B, and unlinking it clears it on B", async () => {
    await a.db.lots.update((await theLot(a)).id!, {
      consignorId: await consignorId(a, 7),
      updatedAt: T1,
    });
    const first = await buildEventExport(a.db, a.eventId);
    await mergeServerSnapshotIntoLocal(b.db, b.eventId, first, { localBase: base });
    expect((await theLot(b)).consignorId).toBe(await consignorId(b, 7));

    await a.db.lots.update((await theLot(a)).id!, {
      consignorId: undefined,
      updatedAt: new Date("2026-01-03T00:00:00.000Z"),
    });
    const second = await buildEventExport(a.db, a.eventId);
    // B's last cloud copy is now the first one.
    await mergeServerSnapshotIntoLocal(b.db, b.eventId, second, { localBase: first });
    expect((await theLot(b)).consignorId).toBeUndefined();
  });

  it("links B changed since its last cloud copy are kept, even where the cloud has others", async () => {
    // B has unsaved link edits; A's cloud copy has the old links.
    await b.db.sales.update((await theSale(b)).id!, {
      invoiceId: await invoiceId(b, "inv-b"),
      consignorId: await consignorId(b, 7),
    });
    await b.db.lots.update((await theLot(b)).id!, {
      consignorId: await consignorId(b, 7),
      updatedAt: T0,
    });
    // A meanwhile linked the lot to another consignor, with a newer edit time.
    await a.db.lots.update((await theLot(a)).id!, {
      consignorId: await consignorId(a, 8),
      updatedAt: T1,
    });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, { localBase: base });

    const sale = await theSale(b);
    expect(sale.invoiceId).toBe(await invoiceId(b, "inv-b"));
    expect(sale.consignorId).toBe(await consignorId(b, 7));
    expect((await theLot(b)).consignorId).toBe(await consignorId(b, 7));
  });

  it("each link is decided on its own: B's invoice move and A's consignor change both survive", async () => {
    await a.db.sales.update((await theSale(a)).id!, {
      consignorId: await consignorId(a, 8),
    });
    await b.db.sales.update((await theSale(b)).id!, {
      invoiceId: await invoiceId(b, "inv-b"),
    });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, { localBase: base });

    const sale = await theSale(b);
    expect(sale.invoiceId).toBe(await invoiceId(b, "inv-b"));
    expect(sale.consignorId).toBe(await consignorId(b, 8));
  });

  it("with no stored cloud copy, this device's links are kept (as before)", async () => {
    await a.db.sales.update((await theSale(a)).id!, {
      invoiceId: await invoiceId(a, "inv-b"),
    });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud);

    expect((await theSale(b)).invoiceId).toBe(await invoiceId(b, "inv-a"));
  });

  it("a refresh of a device with nothing unsaved takes the cloud's links even without a stored copy", async () => {
    const pulled = new Date("2026-01-05T00:00:00.000Z");
    await b.db.events.update(b.eventId, { lastCloudPullAt: T0, updatedAt: T0 });
    await a.db.sales.update((await theSale(a)).id!, {
      invoiceId: await invoiceId(a, "inv-b"),
    });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, {
      refreshPulledAt: pulled,
      now: pulled,
    });

    expect((await theSale(b)).invoiceId).toBe(await invoiceId(b, "inv-b"));
  });

  it("a sale moved to another bidder and lot takes the new paddle and lot number with it", async () => {
    for (const d of [a, b]) {
      await d.db.bidders.add({
        eventId: d.eventId, paddleNumber: 2, firstName: "Bob", lastName: "Jones", createdAt: T0, updatedAt: T0,
      });
      await d.db.lots.add({
        eventId: d.eventId, baseLotNumber: 2, lotSuffix: "", displayLotNumber: "2", description: "Table",
        quantity: 1, status: "sold", createdAt: T0, updatedAt: T0,
      });
    }
    const bidder2 = async (d: Device) =>
      (await d.db.bidders.where("eventId").equals(d.eventId).filter((r) => r.paddleNumber === 2).first())!.id!;
    const lot2 = async (d: Device) =>
      (await d.db.lots.where("eventId").equals(d.eventId).filter((r) => r.displayLotNumber === "2").first())!.id!;
    await a.db.sales.update((await theSale(a)).id!, {
      bidderId: await bidder2(a),
      paddleNumber: 2,
      lotId: await lot2(a),
      displayLotNumber: "2",
    });
    const cloud = await buildEventExport(a.db, a.eventId);

    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, { localBase: base });

    const sale = await theSale(b);
    expect(sale.paddleNumber).toBe(2);
    expect(sale.displayLotNumber).toBe("2");
    expect(sale.bidderId).toBe(await bidder2(b));
    expect(sale.lotId).toBe(await lot2(b));
  });

  it("a second refresh of the same snapshot changes nothing", async () => {
    await a.db.sales.update((await theSale(a)).id!, {
      invoiceId: await invoiceId(a, "inv-b"),
    });
    const cloud = await buildEventExport(a.db, a.eventId);
    await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, { localBase: base });
    const again = await mergeServerSnapshotIntoLocal(b.db, b.eventId, cloud, {
      localBase: cloud,
    });
    expect(again.salesUpdated).toBe(0);
    expect(again.lotsUpdated).toBe(0);
  });
});

describe("download does not invent sale-to-invoice links (#42)", () => {
  async function exportWithUnallocatedSale(version: number): Promise<EventExportPayload> {
    const a = await seedDevice();
    await a.db.sales.update((await theSale(a)).id!, { invoiceId: undefined });
    // Drop the second invoice so the bidder has exactly one: the old guess
    // would attach the unallocated sale to it.
    await a.db.invoices.delete(await invoiceId(a, "inv-b"));
    const payload = await buildEventExport(a.db, a.eventId);
    return { ...payload, exportVersion: version };
  }

  async function importAndGetSale(payload: EventExportPayload) {
    const fresh = new AuctionDB(`links_import_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const { eventId } = await importEventFromPayload(fresh, payload);
    const d = { db: fresh, eventId };
    devices.push(d);
    return { d, sale: await theSale(d) };
  }

  it("current exports keep an unallocated sale unallocated, so an idle re-export compares unchanged", async () => {
    const payload = await exportWithUnallocatedSale(EXPORT_VERSION);
    const { d, sale } = await importAndGetSale(payload);
    expect(sale.invoiceId ?? null).toBeNull();
    // Payloads travel as JSON, which drops undefined fields.
    const wire = (p: unknown) => JSON.parse(JSON.stringify(p));
    const again = await buildEventExport(d.db, d.eventId);
    expect(eventSnapshotsContentEqual(wire(payload), wire(again))).toBe(true);
  });

  it("exports older than version 4, which have no sale-to-invoice link, still attach to the bidder's only invoice", async () => {
    const payload = await exportWithUnallocatedSale(3);
    const { d, sale } = await importAndGetSale(payload);
    const inv = await d.db.invoices.where("eventId").equals(d.eventId).first();
    expect(sale.invoiceId).toBe(inv!.id);
  });
});
