import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import { mergeServerSnapshotIntoLocal } from "@/lib/services/snapshotMerge";
import type { EventExportPayload } from "@/lib/services/dataPorter";

let db: AuctionDB;
let eventId: number;

function makePayload(
  overrides?: Partial<EventExportPayload>
): EventExportPayload {
  return {
    exportVersion: 6,
    exportDate: new Date().toISOString(),
    appVersion: "test",
    event: {
      name: "Test Auction",
      organizationName: "Test Org",
      taxRate: 0.08,
      buyersPremiumRate: 0.1,
      defaultConsignorCommissionRate: 0.15,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    bidders: [],
    consignors: [],
    lots: [],
    sales: [],
    invoices: [],
    ...overrides,
  };
}

beforeEach(async () => {
  const uid = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  db = new AuctionDB(uid);
  eventId = (await db.events.add({
    name: "Test Auction",
    organizationName: "Test Org",
    taxRate: 0.08,
    buyersPremiumRate: 0.1,
    defaultConsignorCommissionRate: 0.15,
    currencySymbol: "$",
    syncId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  })) as number;
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

describe("mergeServerSnapshotIntoLocal", () => {
  describe("bidders", () => {
    it("adds server-only bidders to local", async () => {
      const payload = makePayload({
        bidders: [
          {
            paddleNumber: 1,
            firstName: "Alice",
            lastName: "Smith",
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.biddersAdded).toBe(1);
      expect(summary.biddersUpdated).toBe(0);
      const bidders = await db.bidders.where("eventId").equals(eventId).toArray();
      expect(bidders).toHaveLength(1);
      expect(bidders[0].firstName).toBe("Alice");
      expect(bidders[0].paddleNumber).toBe(1);
    });

    it("updates local bidder when server is newer", async () => {
      await db.bidders.add({
        eventId,
        paddleNumber: 1,
        firstName: "Alice",
        lastName: "Smith",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      const payload = makePayload({
        bidders: [
          {
            paddleNumber: 1,
            firstName: "Alice Updated",
            lastName: "Johnson",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.biddersAdded).toBe(0);
      expect(summary.biddersUpdated).toBe(1);
      const bidders = await db.bidders.where("eventId").equals(eventId).toArray();
      expect(bidders).toHaveLength(1);
      expect(bidders[0].firstName).toBe("Alice Updated");
      expect(bidders[0].lastName).toBe("Johnson");
    });

    it("keeps local bidder when local is newer", async () => {
      await db.bidders.add({
        eventId,
        paddleNumber: 1,
        firstName: "Alice Local",
        lastName: "Local",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      });

      const payload = makePayload({
        bidders: [
          {
            paddleNumber: 1,
            firstName: "Alice Server",
            lastName: "Server",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.biddersAdded).toBe(0);
      expect(summary.biddersUpdated).toBe(0);
      const bidders = await db.bidders.where("eventId").equals(eventId).toArray();
      expect(bidders).toHaveLength(1);
      expect(bidders[0].firstName).toBe("Alice Local");
    });

    it("preserves local-only bidders not in server snapshot", async () => {
      await db.bidders.add({
        eventId,
        paddleNumber: 99,
        firstName: "Local Only",
        lastName: "Bidder",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      const payload = makePayload({
        bidders: [
          {
            paddleNumber: 1,
            firstName: "Server Only",
            lastName: "Bidder",
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.biddersAdded).toBe(1);
      const bidders = await db.bidders.where("eventId").equals(eventId).toArray();
      expect(bidders).toHaveLength(2);
      const paddles = bidders.map((b) => b.paddleNumber).sort();
      expect(paddles).toEqual([1, 99]);
    });
  });

  describe("lots", () => {
    it("adds server-only lots and keeps local-only lots", async () => {
      await db.lots.add({
        eventId,
        baseLotNumber: 1,
        lotSuffix: "",
        displayLotNumber: "1",
        description: "Local lot",
        quantity: 1,
        status: "unsold",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      const payload = makePayload({
        lots: [
          {
            baseLotNumber: 2,
            lotSuffix: "",
            displayLotNumber: "2",
            description: "Server lot",
            quantity: 1,
            status: "unsold",
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.lotsAdded).toBe(1);
      const lots = await db.lots.where("eventId").equals(eventId).toArray();
      expect(lots).toHaveLength(2);
    });
  });

  describe("sales", () => {
    it("adds server-only sales matched by syncKey", async () => {
      const bidderId = (await db.bidders.add({
        eventId,
        paddleNumber: 1,
        firstName: "A",
        lastName: "B",
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as number;
      const lotId = (await db.lots.add({
        eventId,
        baseLotNumber: 1,
        lotSuffix: "",
        displayLotNumber: "1",
        description: "Lot",
        quantity: 1,
        status: "unsold",
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as number;

      const payload = makePayload({
        bidders: [
          {
            legacyId: 100,
            paddleNumber: 1,
            firstName: "A",
            lastName: "B",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        lots: [
          {
            legacyId: 200,
            baseLotNumber: 1,
            lotSuffix: "",
            displayLotNumber: "1",
            description: "Lot",
            quantity: 1,
            status: "unsold",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sales: [
          {
            displayLotNumber: "1",
            paddleNumber: 1,
            description: "Server sale",
            quantity: 1,
            amount: 100,
            clerkInitials: "AB",
            createdAt: "2026-01-02T00:00:00.000Z",
            syncKey: "sale-key-1",
            legacyLotId: 200,
            legacyBidderId: 100,
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.salesAdded).toBe(1);
      const sales = await db.sales.where("eventId").equals(eventId).toArray();
      expect(sales).toHaveLength(1);
      expect(sales[0].description).toBe("Server sale");
      expect(sales[0].syncKey).toBe("sale-key-1");
      expect(sales[0].lotId).toBe(lotId);
      expect(sales[0].bidderId).toBe(bidderId);
    });

    it("does not overwrite local sale when local is newer", async () => {
      const bidderId = (await db.bidders.add({
        eventId,
        paddleNumber: 1,
        firstName: "A",
        lastName: "B",
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as number;
      const lotId = (await db.lots.add({
        eventId,
        baseLotNumber: 1,
        lotSuffix: "",
        displayLotNumber: "1",
        description: "Lot",
        quantity: 1,
        status: "unsold",
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as number;

      await db.sales.add({
        eventId,
        lotId,
        bidderId,
        displayLotNumber: "1",
        paddleNumber: 1,
        description: "Local sale (newer)",
        quantity: 1,
        amount: 200,
        clerkInitials: "CD",
        createdAt: new Date("2026-01-03T00:00:00.000Z"),
        syncKey: "sale-key-1",
      });

      const payload = makePayload({
        bidders: [
          {
            legacyId: 100,
            paddleNumber: 1,
            firstName: "A",
            lastName: "B",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        lots: [
          {
            legacyId: 200,
            baseLotNumber: 1,
            lotSuffix: "",
            displayLotNumber: "1",
            description: "Lot",
            quantity: 1,
            status: "unsold",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        sales: [
          {
            displayLotNumber: "1",
            paddleNumber: 1,
            description: "Server sale (older)",
            quantity: 1,
            amount: 100,
            clerkInitials: "AB",
            createdAt: "2026-01-02T00:00:00.000Z",
            syncKey: "sale-key-1",
            legacyLotId: 200,
            legacyBidderId: 100,
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.salesAdded).toBe(0);
      expect(summary.salesUpdated).toBe(0);
      const sales = await db.sales.where("eventId").equals(eventId).toArray();
      expect(sales).toHaveLength(1);
      expect(sales[0].description).toBe("Local sale (newer)");
      expect(sales[0].amount).toBe(200);
    });
  });

  describe("invoices", () => {
    it("adds server-only invoices matched by syncKey", async () => {
      await db.bidders.add({
        eventId,
        paddleNumber: 5,
        firstName: "Bob",
        lastName: "Jones",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const payload = makePayload({
        bidders: [
          {
            legacyId: 50,
            paddleNumber: 5,
            firstName: "Bob",
            lastName: "Jones",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        invoices: [
          {
            invoiceNumber: "INV-001",
            subtotal: 100,
            buyersPremiumAmount: 10,
            taxAmount: 8.8,
            total: 118.8,
            status: "unpaid" as const,
            generatedAt: "2026-01-02T00:00:00.000Z",
            syncKey: "inv-key-1",
            legacyBidderId: 50,
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      expect(summary.invoicesAdded).toBe(1);
      const invoices = await db.invoices.where("eventId").equals(eventId).toArray();
      expect(invoices).toHaveLength(1);
      expect(invoices[0].invoiceNumber).toBe("INV-001");
      expect(invoices[0].syncKey).toBe("inv-key-1");
    });

    it("does not rewrite an unpaid invoice when totals match even if generatedAt is newer", async () => {
      const bidderId = (await db.bidders.add({
        eventId,
        paddleNumber: 5,
        firstName: "Bob",
        lastName: "Jones",
        createdAt: new Date(),
        updatedAt: new Date(),
      })) as number;
      const generatedAt = new Date("2026-01-02T00:00:00.000Z");
      await db.invoices.add({
        eventId,
        bidderId,
        invoiceNumber: "INV-001",
        subtotal: 100,
        buyersPremiumAmount: 10,
        taxAmount: 8.8,
        total: 118.8,
        status: "unpaid",
        generatedAt,
        syncKey: "inv-key-1",
      });

      const payload = makePayload({
        bidders: [
          {
            legacyId: 50,
            paddleNumber: 5,
            firstName: "Bob",
            lastName: "Jones",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        invoices: [
          {
            invoiceNumber: "INV-001",
            subtotal: 100,
            buyersPremiumAmount: 10,
            taxAmount: 8.8,
            total: 118.8,
            status: "unpaid" as const,
            generatedAt: "2026-01-03T00:00:00.000Z",
            syncKey: "inv-key-1",
            legacyBidderId: 50,
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);
      expect(summary.invoicesUpdated).toBe(0);
      const invoices = await db.invoices.where("eventId").equals(eventId).toArray();
      expect(invoices[0].generatedAt.getTime()).toBe(generatedAt.getTime());
    });
  });

  describe("full merge scenario", () => {
    it("merges entities from both sides without data loss", async () => {
      // Local: bidder 1, lot 1, sale on lot 1 by bidder 1
      await db.bidders.add({
        eventId,
        paddleNumber: 1,
        firstName: "Local",
        lastName: "Bidder",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      });
      const localLotId = (await db.lots.add({
        eventId,
        baseLotNumber: 1,
        lotSuffix: "",
        displayLotNumber: "1",
        description: "Local lot",
        quantity: 1,
        status: "unsold",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      })) as number;
      const localBidderId = (await db.bidders.where("eventId").equals(eventId).first())!.id!;
      await db.sales.add({
        eventId,
        lotId: localLotId,
        bidderId: localBidderId,
        displayLotNumber: "1",
        paddleNumber: 1,
        description: "Local sale",
        quantity: 1,
        amount: 50,
        clerkInitials: "LC",
        createdAt: new Date("2026-01-01T12:00:00.000Z"),
        syncKey: "local-sale-1",
      });

      // Server: bidder 2, lot 2, sale on lot 2 by bidder 2 (different device)
      const payload = makePayload({
        bidders: [
          {
            legacyId: 1,
            paddleNumber: 1,
            firstName: "Local",
            lastName: "Bidder",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            legacyId: 2,
            paddleNumber: 2,
            firstName: "Server",
            lastName: "Bidder",
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        lots: [
          {
            legacyId: 1,
            baseLotNumber: 1,
            lotSuffix: "",
            displayLotNumber: "1",
            description: "Local lot",
            quantity: 1,
            status: "unsold",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            legacyId: 2,
            baseLotNumber: 2,
            lotSuffix: "",
            displayLotNumber: "2",
            description: "Server lot",
            quantity: 1,
            status: "unsold",
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        sales: [
          {
            displayLotNumber: "2",
            paddleNumber: 2,
            description: "Server sale",
            quantity: 1,
            amount: 75,
            clerkInitials: "SV",
            createdAt: "2026-01-02T12:00:00.000Z",
            syncKey: "server-sale-1",
            legacyLotId: 2,
            legacyBidderId: 2,
          },
        ],
      });

      const summary = await mergeServerSnapshotIntoLocal(db, eventId, payload);

      // Should have added server's bidder 2, lot 2, and sale
      expect(summary.biddersAdded).toBe(1);
      expect(summary.lotsAdded).toBe(1);
      expect(summary.salesAdded).toBe(1);

      // Both sides' data should be present
      const bidders = await db.bidders.where("eventId").equals(eventId).toArray();
      expect(bidders).toHaveLength(2);

      const lots = await db.lots.where("eventId").equals(eventId).toArray();
      expect(lots).toHaveLength(2);

      const sales = await db.sales.where("eventId").equals(eventId).toArray();
      expect(sales).toHaveLength(2);
      const syncKeys = sales.map((s) => s.syncKey).sort();
      expect(syncKeys).toEqual(["local-sale-1", "server-sale-1"]);
    });
  });

  describe("event metadata", () => {
    it("updates event-level config from server", async () => {
      const payload = makePayload({
        event: {
          name: "Updated Name",
          organizationName: "New Org",
          taxRate: 0.1,
          buyersPremiumRate: 0.15,
          defaultConsignorCommissionRate: 0.2,
          currencySymbol: "€",
          syncId: "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      });

      await mergeServerSnapshotIntoLocal(db, eventId, payload);

      const event = await db.events.get(eventId);
      expect(event!.name).toBe("Updated Name");
      expect(event!.organizationName).toBe("New Org");
      expect(event!.taxRate).toBe(0.1);
      expect(event!.buyersPremiumRate).toBe(0.15);
      expect(event!.currencySymbol).toBe("€");
    });
  });

  describe("idempotency", () => {
    it("merging the same snapshot twice produces the same result", async () => {
      const payload = makePayload({
        bidders: [
          {
            paddleNumber: 1,
            firstName: "Alice",
            lastName: "Smith",
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        lots: [
          {
            baseLotNumber: 1,
            lotSuffix: "",
            displayLotNumber: "1",
            description: "Test lot",
            quantity: 1,
            status: "unsold",
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      });

      await mergeServerSnapshotIntoLocal(db, eventId, payload);
      const bidders1 = await db.bidders.where("eventId").equals(eventId).toArray();
      const lots1 = await db.lots.where("eventId").equals(eventId).toArray();

      const summary2 = await mergeServerSnapshotIntoLocal(db, eventId, payload);
      const bidders2 = await db.bidders.where("eventId").equals(eventId).toArray();
      const lots2 = await db.lots.where("eventId").equals(eventId).toArray();

      expect(summary2.biddersAdded).toBe(0);
      expect(summary2.lotsAdded).toBe(0);
      expect(bidders2).toHaveLength(bidders1.length);
      expect(lots2).toHaveLength(lots1.length);
    });
  });
});
