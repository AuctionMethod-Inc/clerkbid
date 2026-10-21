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
  cloudBaseUpdatedAt,
  flushSingleEventToCloudSnapshot,
  pushEventWithAutoMerge,
  refreshEventFromCloudIfServerNewer,
  recordSuccessfulPush,
  restoreEventFromCloud,
} from "@/lib/services/cloudSync";

const SYNC_ID = "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee";

type Device = { db: AuctionDB; eventId: number };
const devices: Device[] = [];
let pushBodies: Array<{ baseUpdatedAt?: string | null; force?: boolean }> = [];

async function newDevice(): Promise<Device> {
  const db = new AuctionDB(`push_${Date.now()}_${Math.random().toString(36).slice(2)}`);
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

async function addBidder(d: Device, paddleNumber: number, createdAt = new Date()) {
  await d.db.bidders.add({
    eventId: d.eventId,
    paddleNumber,
    firstName: `B${paddleNumber}`,
    lastName: "Test",
    createdAt,
    updatedAt: createdAt,
  });
}

/** What the sync cycle does: push, then record the baseline. */
async function save(d: Device, options?: { force?: boolean }) {
  const result = await pushEventWithAutoMerge(d.db, d.eventId, options);
  if (result.ok && !result.unchanged) {
    await recordSuccessfulPush(d.db, d.eventId, result.updatedAt);
  }
  return result;
}

function cloudPaddles(): number[] {
  const payload = JSON.parse(table.row!.payload) as {
    bidders: Array<{ paddleNumber: number }>;
  };
  return payload.bidders.map((b) => b.paddleNumber).sort();
}

beforeEach(() => {
  table.row = null;
  table.clock = 0;
  // Server time a minute behind the test clock, as with a device whose
  // export time is a little later than the server's last save.
  table.start = Date.now() - 60_000;
  pushBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/sync/push/")) {
        pushBodies.push(JSON.parse(String(init?.body)));
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

describe("cloudBaseUpdatedAt", () => {
  it("is null with no pull or push, else the later of the two", () => {
    expect(cloudBaseUpdatedAt({})).toBeNull();
    expect(
      cloudBaseUpdatedAt({
        lastCloudPullAt: new Date("2026-01-01T00:00:00.000Z"),
        lastCloudPushAt: new Date("2026-01-02T00:00:00.000Z"),
      })
    ).toBe("2026-01-02T00:00:00.000Z");
  });
});

describe("pushEventWithAutoMerge against the push route", () => {
  it("a save that never saw the other device's sale merges it instead of overwriting it", async () => {
    const a = await newDevice();
    const b = await newDevice();
    await addBidder(a, 1);
    expect((await save(a)).ok).toBe(true);
    await restoreEventFromCloud(b.db, b.eventId, SYNC_ID);

    // B enters sale X (a bidder here) and saves. A, still on the first
    // version, enters Y and saves a moment later.
    await addBidder(b, 2);
    expect((await save(b)).ok).toBe(true);
    await addBidder(a, 3);
    const result = await save(a);

    expect(result.ok && result.autoMerged).toBe(true);
    expect(cloudPaddles()).toEqual([1, 2, 3]);
    const onA = await a.db.bidders.where("eventId").equals(a.eventId).toArray();
    expect(onA.map((x) => x.paddleNumber).sort()).toEqual([1, 2, 3]);
  });

  it("sends the cloud version the device last saw, and the merged retry sends the version it merged", async () => {
    const a = await newDevice();
    await addBidder(a, 1);
    await save(a);
    const first = (await a.db.events.get(a.eventId))!;
    await addBidder(a, 2);
    await save(a);

    expect(pushBodies[0]!.baseUpdatedAt).toBeNull();
    expect(pushBodies[1]!.baseUpdatedAt).toBe(cloudBaseUpdatedAt(first));
  });

  it("an up-to-date device saves in one request without merging", async () => {
    const a = await newDevice();
    await addBidder(a, 1);
    await save(a);
    await addBidder(a, 2);
    const result = await save(a);
    expect(result.ok && result.autoMerged).toBe(false);
    expect(pushBodies).toHaveLength(2);
  });

  it("reports a conflict when the cloud keeps moving, after a few merged retries", async () => {
    const a = await newDevice();
    await addBidder(a, 1);
    await save(a);
    // Every save from A finds the cloud already changed.
    const real = fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = real.getMockImplementation()!;
    real.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/sync/push/")) {
        table.row = {
          ...table.row!,
          updated_at: new Date(table.row!.updated_at.getTime() + 1000),
          updated_at_exact: "moved",
        };
      }
      return inner(url, init);
    });
    await addBidder(a, 2);
    const before = pushBodies.length;
    const result = await save(a);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.conflict).toBe(true);
    // 1 first try + 3 merged retries
    expect(pushBodies.length - before).toBe(4);
  });

  it("a forced save overwrites without a base check", async () => {
    const a = await newDevice();
    const b = await newDevice();
    await addBidder(a, 1);
    await save(a);
    await addBidder(b, 9);
    const result = await save(b, { force: true });
    expect(result.ok && result.autoMerged).toBe(false);
    expect(cloudPaddles()).toEqual([9]);
  });

  it("event settings changed on this device survive the merge after a refused save", async () => {
    const a = await newDevice();
    const b = await newDevice();
    await addBidder(a, 1);
    await save(a);
    await restoreEventFromCloud(b.db, b.eventId, SYNC_ID);

    // B saves; A, on the older version, changes the tax rate and saves.
    await addBidder(b, 2);
    await save(b);
    await a.db.events.update(a.eventId, { taxRate: 0.2, updatedAt: new Date() });
    const result = await save(a);

    expect(result.ok && result.autoMerged).toBe(true);
    const cloud = JSON.parse(table.row!.payload) as {
      event: { taxRate: number };
    };
    expect(cloud.event.taxRate).toBe(0.2);
    expect(cloudPaddles()).toEqual([1, 2]);
  });

  it("a delete flushed from a device that has not seen the latest cloud copy stays deleted", async () => {
    const a = await newDevice();
    const b = await newDevice();
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await addBidder(a, 1, anHourAgo);
    await addBidder(a, 2, anHourAgo);
    await save(a);
    await restoreEventFromCloud(b.db, b.eventId, SYNC_ID);

    await addBidder(b, 3);
    await save(b);
    const doomed = await a.db.bidders.where("eventId").equals(a.eventId).filter((x) => x.paddleNumber === 2).first();
    await a.db.bidders.delete(doomed!.id!);
    expect(await flushSingleEventToCloudSnapshot(a.db, a.eventId)).toBe(true);

    expect(cloudPaddles()).not.toContain(2);
    const onA = await a.db.bidders.where("eventId").equals(a.eventId).toArray();
    expect(onA.map((x) => x.paddleNumber)).not.toContain(2);
  });

  it("a delete saved by the normal sync cycle (not flushed) also stays deleted", async () => {
    const a = await newDevice();
    const b = await newDevice();
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await addBidder(a, 1, anHourAgo);
    await addBidder(a, 2, anHourAgo);
    await save(a);
    await restoreEventFromCloud(b.db, b.eventId, SYNC_ID);

    await addBidder(b, 3);
    await save(b);
    const doomed = await a.db.bidders.where("eventId").equals(a.eventId).filter((x) => x.paddleNumber === 2).first();
    await a.db.bidders.delete(doomed!.id!);
    await a.db.events.update(a.eventId, { updatedAt: new Date() });
    const result = await save(a);

    expect(result.ok && result.autoMerged).toBe(true);
    expect(cloudPaddles()).toEqual([1, 3]);
  });

  it("a sale moved to another invoice on A survives B's next sync cycle when B has no unsaved edits yet (refresh, then save)", async () => {
    const T0 = new Date("2026-01-01T00:00:00.000Z");
    const a = await newDevice();
    const b = await newDevice();
    const bidderId = (await a.db.bidders.add({
      eventId: a.eventId, paddleNumber: 1, firstName: "A", lastName: "B", createdAt: T0, updatedAt: T0,
    })) as number;
    const lotId = (await a.db.lots.add({
      eventId: a.eventId, baseLotNumber: 1, lotSuffix: "", displayLotNumber: "1", description: "Chair",
      quantity: 1, status: "sold", createdAt: T0, updatedAt: T0,
    })) as number;
    const inv = (syncKey: string, invoiceNumber: string) => ({
      eventId: a.eventId, bidderId, invoiceNumber, subtotal: 0, buyersPremiumAmount: 0, taxAmount: 0,
      total: 0, status: "unpaid" as const, generatedAt: T0, syncKey,
    });
    const invA = (await a.db.invoices.add(inv("inv-a", "1-001"))) as number;
    const invB = (await a.db.invoices.add(inv("inv-b", "1-002"))) as number;
    const saleId = (await a.db.sales.add({
      eventId: a.eventId, lotId, bidderId, displayLotNumber: "1", paddleNumber: 1, description: "Chair",
      quantity: 1, amount: 50, clerkInitials: "AB", createdAt: T0, syncKey: "sale-1", invoiceId: invA,
    })) as number;
    await save(a);
    await restoreEventFromCloud(b.db, b.eventId, SYNC_ID);

    // A moves the sale to the other invoice and saves.
    await a.db.sales.update(saleId, { invoiceId: invB });
    await a.db.events.update(a.eventId, { updatedAt: new Date() });
    expect((await save(a)).ok).toBe(true);

    // B runs its sync cycle (refresh, then save) and enters a bidder after the
    // refresh. A device that already has unsaved edits at refresh time keeps
    // its own links instead; see the next test.
    expect((await refreshEventFromCloudIfServerNewer(b.db, b.eventId)).refreshed).toBe(true);
    await addBidder(b, 2);
    expect((await save(b)).ok).toBe(true);

    const cloud = JSON.parse(table.row!.payload) as {
      sales: Array<{ legacyInvoiceId?: number }>;
      invoices: Array<{ legacyId?: number; syncKey?: string }>;
    };
    const linked = cloud.invoices.find((i) => i.legacyId === cloud.sales[0]!.legacyInvoiceId);
    expect(linked?.syncKey).toBe("inv-b");
    expect(cloudPaddles()).toEqual([1, 2]);
  });

  it("an unsaved link edit on this device survives a refresh (the cloud's link is not applied over it)", async () => {
    const T0 = new Date("2026-01-01T00:00:00.000Z");
    const a = await newDevice();
    const b = await newDevice();
    const bidderId = (await a.db.bidders.add({
      eventId: a.eventId, paddleNumber: 1, firstName: "A", lastName: "B", createdAt: T0, updatedAt: T0,
    })) as number;
    const lotId = (await a.db.lots.add({
      eventId: a.eventId, baseLotNumber: 1, lotSuffix: "", displayLotNumber: "1", description: "Chair",
      quantity: 1, status: "sold", createdAt: T0, updatedAt: T0,
    })) as number;
    const inv = (syncKey: string, invoiceNumber: string) => ({
      eventId: a.eventId, bidderId, invoiceNumber, subtotal: 0, buyersPremiumAmount: 0, taxAmount: 0,
      total: 0, status: "unpaid" as const, generatedAt: T0, syncKey,
    });
    const invA = (await a.db.invoices.add(inv("inv-a", "1-001"))) as number;
    const invB = (await a.db.invoices.add(inv("inv-b", "1-002"))) as number;
    const saleId = (await a.db.sales.add({
      eventId: a.eventId, lotId, bidderId, displayLotNumber: "1", paddleNumber: 1, description: "Chair",
      quantity: 1, amount: 50, clerkInitials: "AB", createdAt: T0, syncKey: "sale-1", invoiceId: invA,
    })) as number;
    await save(a);
    await restoreEventFromCloud(b.db, b.eventId, SYNC_ID);

    // A moves the sale to inv-b and saves. B, meanwhile, removed it from its
    // invoice and has not saved yet.
    await a.db.sales.update(saleId, { invoiceId: invB });
    await a.db.events.update(a.eventId, { updatedAt: new Date() });
    await save(a);
    const bSale = (await b.db.sales.where("eventId").equals(b.eventId).toArray())[0]!;
    await b.db.sales.update(bSale.id!, { invoiceId: undefined });
    await b.db.events.update(b.eventId, { updatedAt: new Date() });

    expect((await refreshEventFromCloudIfServerNewer(b.db, b.eventId)).refreshed).toBe(true);

    const after = (await b.db.sales.where("eventId").equals(b.eventId).toArray())[0]!;
    expect(after.invoiceId ?? null).toBeNull();
  });
});
