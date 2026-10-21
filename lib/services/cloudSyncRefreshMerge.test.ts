import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => ({ user: { id: "7", vendorId: "3" } })),
}));
vi.mock("@/lib/auth/options", () => ({ authOptions: {} }));
vi.mock("@/lib/ably/publishEventSync", () => ({
  publishEventSyncNudge: vi.fn(),
}));

/** In-memory event_cloud_snapshots, one event, shared by both "devices". */
const table: {
  row: { payload: string; updated_at: Date; updated_at_exact: string } | null;
  clock: number;
  start: number;
} = { row: null, clock: 0, start: 0 };

vi.mock("@/lib/db/postgres", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    const r = table.row;
    if (text.includes("updated_at::text AS updated_at_exact")) {
      return {
        rows: r
          ? [
              {
                updated_at: r.updated_at,
                updated_at_exact: r.updated_at_exact,
                payload: JSON.parse(r.payload),
              },
            ]
          : [],
      };
    }
    if (text.includes("INSERT INTO event_cloud_snapshots")) {
      const unconditional = values[values.length - 2] as boolean;
      const expected = values[values.length - 1] as string | null;
      if (!unconditional && r && r.updated_at_exact !== expected) {
        return { rows: [] };
      }
      table.clock += 1000;
      const now = new Date(table.start + table.clock);
      table.row = {
        payload: values[3] as string,
        updated_at: now,
        updated_at_exact: `${now.toISOString()}+123us`,
      };
      return { rows: [{ updated_at: now }] };
    }
    if (text.includes("SELECT payload, updated_at")) {
      return {
        rows: r ? [{ payload: JSON.parse(r.payload), updated_at: r.updated_at }] : [],
      };
    }
    if (text.includes("SELECT updated_at")) {
      return { rows: r ? [{ updated_at: r.updated_at }] : [] };
    }
    throw new Error(`unexpected query: ${text}`);
  }),
}));

import { POST as pushRoute } from "@/app/api/sync/push/route";
import { GET as eventRoute } from "@/app/api/sync/event/route";
import {
  hasUnpushedLocalEventMetadataEdits,
  pushEventWithAutoMerge,
  recordSuccessfulPush,
  refreshEventFromCloudIfServerNewer,
  restoreEventFromCloud,
} from "@/lib/services/cloudSync";

const SYNC_ID = "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee";
const INVOICE_KEY = "inv-0001";
const SALE_KEY = "sale-0001";

type Device = { db: AuctionDB; eventId: number };
const devices: Device[] = [];
/** Runs once inside the next push request, before the server sees it. */
let duringNextPush: (() => Promise<void>) | null = null;

async function newDevice(): Promise<Device> {
  const db = new AuctionDB(`refresh_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const eventId = (await db.events.add({
    name: "Test Auction",
    organizationName: "Test Org",
    taxRate: 0.08,
    buyersPremiumRate: 0.1,
    defaultConsignorCommissionRate: 0.15,
    currencySymbol: "$",
    syncId: SYNC_ID,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })) as number;
  const d = { db, eventId };
  devices.push(d);
  return d;
}

/** Lets the hook that marks the event unsaved (after each write) land. */
const settle = () => new Promise((r) => setTimeout(r, 20));

async function addBidder(d: Device, paddleNumber: number, createdAt = new Date()) {
  const id = (await d.db.bidders.add({
    eventId: d.eventId,
    paddleNumber,
    firstName: `B${paddleNumber}`,
    lastName: "Test",
    createdAt,
    updatedAt: createdAt,
  })) as number;
  await settle();
  return id;
}

/** Bidder 1 with lot 1 sold to them (entered 2 minutes ago) on invoice 1-001. */
async function seedSaleAndInvoice(d: Device) {
  const anHourAgo = new Date(Date.now() - 3_600_000);
  const bidderId = await addBidder(d, 1, anHourAgo);
  const lotId = (await d.db.lots.add({
    eventId: d.eventId,
    baseLotNumber: 1,
    lotSuffix: "",
    displayLotNumber: "1",
    description: "Lamp",
    quantity: 1,
    status: "sold",
    createdAt: anHourAgo,
    updatedAt: anHourAgo,
  })) as number;
  const invoiceId = (await d.db.invoices.add({
    eventId: d.eventId,
    bidderId,
    invoiceNumber: "1-001",
    subtotal: 100,
    buyersPremiumAmount: 10,
    taxAmount: 8.8,
    total: 118.8,
    status: "unpaid",
    generatedAt: anHourAgo,
    syncKey: INVOICE_KEY,
  })) as number;
  await d.db.sales.add({
    eventId: d.eventId,
    lotId,
    bidderId,
    displayLotNumber: "1",
    paddleNumber: 1,
    description: "Lamp",
    quantity: 1,
    amount: 100,
    clerkInitials: "AB",
    createdAt: new Date(Date.now() - 120_000),
    syncKey: SALE_KEY,
    invoiceId,
  });
  await settle();
}

async function pay(d: Device) {
  const inv = await d.db.invoices.where("eventId").equals(d.eventId).first();
  await d.db.invoices.update(inv!.id!, {
    status: "paid",
    paymentMethod: "cash",
    paymentDate: new Date("2026-01-02T00:00:00.000Z"),
  });
  await settle();
}

/** What the sync cycle does: push, then record the baseline. */
async function save(d: Device) {
  const result = await pushEventWithAutoMerge(d.db, d.eventId);
  if (result.ok && !result.unchanged) {
    await recordSuccessfulPush(d.db, d.eventId, result.updatedAt);
  }
  return result;
}

async function deleteBidder(d: Device, paddle: number) {
  const row = await d.db.bidders.where("eventId").equals(d.eventId).filter((x) => x.paddleNumber === paddle).first();
  await d.db.bidders.delete(row!.id!);
  await settle();
}

async function paddlesOn(d: Device): Promise<number[]> {
  const rows = await d.db.bidders.where("eventId").equals(d.eventId).toArray();
  return rows.map((x) => x.paddleNumber).sort((x, y) => x - y);
}

function cloud() {
  return JSON.parse(table.row!.payload) as {
    bidders: Array<{ paddleNumber: number }>;
    invoices: Array<{ syncKey: string; status: string }>;
  };
}

beforeEach(() => {
  table.row = null;
  table.clock = 0;
  table.start = Date.now() - 60_000;
  duringNextPush = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/sync/push/")) {
        const hook = duringNextPush;
        duringNextPush = null;
        if (hook) await hook();
        return pushRoute(
          new Request("http://localhost/api/sync/push/", {
            method: "POST",
            body: init?.body,
          })
        );
      }
      if (url.startsWith("/api/sync/event/")) {
        return eventRoute(new Request(`http://localhost${url}`));
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const d of devices.splice(0)) {
    d.db.close();
    await Dexie.delete(d.db.name);
  }
});

/** A saves the seed, B downloads it: both on the same cloud version. */
async function twoDevicesInSync() {
  const a = await newDevice();
  const b = await newDevice();
  await seedSaleAndInvoice(a);
  await addBidder(a, 2, new Date(Date.now() - 3_600_000));
  expect((await save(a)).ok).toBe(true);
  await restoreEventFromCloud(b.db, b.eventId, SYNC_ID);
  return { a, b };
}

describe("refresh from a newer cloud copy (#35)", () => {
  it("a payment made on A shows on B", async () => {
    const { a, b } = await twoDevicesInSync();
    await pay(a);
    await save(a);

    expect((await refreshEventFromCloudIfServerNewer(b.db, b.eventId)).refreshed).toBe(true);
    const inv = await b.db.invoices.where("eventId").equals(b.eventId).first();
    expect(inv!.status).toBe("paid");
    expect(inv!.paymentMethod).toBe("cash");
  });

  it("a bidder and a sale deleted on A (the sale 2 minutes after it was entered) stay deleted on B", async () => {
    const { a, b } = await twoDevicesInSync();
    await deleteBidder(a, 2);
    const sale = await a.db.sales.where("eventId").equals(a.eventId).first();
    await a.db.sales.delete(sale!.id!);
    await settle();
    await save(a);

    await refreshEventFromCloudIfServerNewer(b.db, b.eventId);
    expect(await paddlesOn(b)).toEqual([1]);
    expect(await b.db.sales.where("eventId").equals(b.eventId).count()).toBe(0);

    // B's next save does not bring them back.
    await addBidder(b, 3);
    await save(b);
    expect(cloud().bidders.map((x) => x.paddleNumber).sort()).toEqual([1, 3]);
  });

  it("an invoice deleted on A is removed on B and its lines go back to unallocated", async () => {
    const { a, b } = await twoDevicesInSync();
    const inv = await a.db.invoices.where("eventId").equals(a.eventId).first();
    await a.db.invoices.delete(inv!.id!);
    await a.db.sales.where("eventId").equals(a.eventId).modify({ invoiceId: null });
    await settle();
    await save(a);

    await refreshEventFromCloudIfServerNewer(b.db, b.eventId);
    expect(await b.db.invoices.where("eventId").equals(b.eventId).count()).toBe(0);
    const sale = await b.db.sales.where("eventId").equals(b.eventId).first();
    expect(sale!.invoiceId ?? null).toBeNull();
  });

  it("unsaved edits on B survive a refresh, and B stays marked unsaved", async () => {
    const { a, b } = await twoDevicesInSync();
    await addBidder(b, 5);
    await deleteBidder(a, 2);
    await save(a);

    await refreshEventFromCloudIfServerNewer(b.db, b.eventId);
    expect(await paddlesOn(b)).toEqual([1, 2, 5]);
    const ev = (await b.db.events.get(b.eventId))!;
    expect(hasUnpushedLocalEventMetadataEdits(ev)).toBe(true);

    await save(b);
    expect(cloud().bidders.map((x) => x.paddleNumber)).toContain(5);
  });

  it("a bidder entered while A's save is in flight is not deleted by A's next refresh", async () => {
    const { a, b } = await twoDevicesInSync();
    await addBidder(a, 3);
    duringNextPush = async () => {
      await addBidder(a, 4);
    };
    await save(a);
    expect(cloud().bidders.map((x) => x.paddleNumber)).not.toContain(4);
    expect(hasUnpushedLocalEventMetadataEdits((await a.db.events.get(a.eventId))!)).toBe(true);

    await refreshEventFromCloudIfServerNewer(b.db, b.eventId);
    await addBidder(b, 6);
    await save(b);
    await refreshEventFromCloudIfServerNewer(a.db, a.eventId);
    expect(await paddlesOn(a)).toContain(4);

    await save(a);
    expect(cloud().bidders.map((x) => x.paddleNumber).sort()).toEqual([1, 2, 3, 4, 6]);
  });

  it("skips deletions when a row it would delete was written seconds ago, and refreshes again next time", async () => {
    const { a, b } = await twoDevicesInSync();
    // B saved bidder 7 but has not marked the event unsaved yet.
    await addBidder(b, 7);
    const before = (await b.db.events.get(b.eventId))!;
    await b.db.events.update(b.eventId, { updatedAt: before.lastCloudPullAt });
    await deleteBidder(a, 2);
    await save(a);

    await refreshEventFromCloudIfServerNewer(b.db, b.eventId);
    expect(await paddlesOn(b)).toEqual([1, 2, 7]);
    const after = (await b.db.events.get(b.eventId))!;
    expect(after.lastCloudPullAt!.getTime()).toBe(before.lastCloudPullAt!.getTime());
  });
});

describe("merge after a refused save uses the last cloud version this device had (#35)", () => {
  it("A's payment is not undone when B, not yet refreshed, saves something else", async () => {
    const { a, b } = await twoDevicesInSync();
    await pay(a);
    await save(a);

    await addBidder(b, 9);
    const result = await save(b);
    expect(result.ok && result.autoMerged).toBe(true);

    expect(cloud().invoices.find((i) => i.syncKey === INVOICE_KEY)!.status).toBe("paid");
    const onB = await b.db.invoices.where("eventId").equals(b.eventId).first();
    expect(onB!.status).toBe("paid");
  });

  it("a payment made on B survives B's refused save", async () => {
    const { a, b } = await twoDevicesInSync();
    await addBidder(a, 8);
    await save(a);

    await pay(b);
    const result = await save(b);
    expect(result.ok && result.autoMerged).toBe(true);
    expect(cloud().invoices.find((i) => i.syncKey === INVOICE_KEY)!.status).toBe("paid");
  });
});
