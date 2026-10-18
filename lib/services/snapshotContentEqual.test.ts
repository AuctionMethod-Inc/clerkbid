import { describe, expect, it } from "vitest";
import { eventSnapshotsContentEqual } from "@/lib/services/snapshotContentEqual";

const base = {
  exportVersion: 6,
  exportDate: "2026-01-01T00:00:00.000Z",
  appVersion: "1.0.0",
  event: {
    name: "Sale",
    syncId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    lastCloudPushAt: "2026-01-01T00:00:00.000Z",
    lastCloudPullAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  bidders: [{ paddleNumber: 1, firstName: "A", lastName: "B", legacyId: 10 }],
  invoices: [
    {
      invoiceNumber: "1-001",
      total: 100,
      status: "unpaid",
      legacyId: 3,
      legacyBidderId: 10,
    },
  ],
};

describe("eventSnapshotsContentEqual", () => {
  it("treats idle re-exports as the same when only volatile fields differ", () => {
    const next = structuredClone(base);
    next.exportDate = "2026-01-01T00:00:45.000Z";
    next.event.lastCloudPushAt = "2026-01-01T00:00:45.000Z";
    next.event.lastCloudPullAt = "2026-01-01T00:00:45.000Z";
    next.bidders[0].legacyId = 99;
    next.invoices[0].legacyId = 88;
    next.invoices[0].legacyBidderId = 99;
    expect(eventSnapshotsContentEqual(base, next)).toBe(true);
  });

  it("is order-insensitive for object keys", () => {
    expect(
      eventSnapshotsContentEqual(
        { exportDate: "1", event: { name: "A", taxRate: 0.1 } },
        { event: { taxRate: 0.1, name: "A" }, exportDate: "2" }
      )
    ).toBe(true);
  });

  it("detects real invoice changes", () => {
    const next = structuredClone(base);
    next.invoices[0].total = 101;
    expect(eventSnapshotsContentEqual(base, next)).toBe(false);
  });

  describe("link-only edits (#42)", () => {
    const linked = {
      exportVersion: 6,
      exportDate: "2026-01-01T00:00:00.000Z",
      event: { name: "Sale", syncId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      bidders: [
        { paddleNumber: 1, firstName: "A", legacyId: 10 },
        { paddleNumber: 2, firstName: "C", legacyId: 11 },
      ],
      consignors: [
        { consignorNumber: 7, name: "Seller", legacyId: 30 },
        { consignorNumber: 8, name: "Other", legacyId: 31 },
      ],
      lots: [
        { displayLotNumber: "1", description: "Chair", legacyId: 20 } as Record<
          string,
          unknown
        >,
      ],
      sales: [
        {
          displayLotNumber: "1",
          paddleNumber: 1,
          amount: 50,
          syncKey: "s-1",
          legacyId: 40,
          legacyLotId: 20,
          legacyBidderId: 10,
          legacyConsignorId: 30,
          legacyInvoiceId: 50,
        } as Record<string, unknown>,
      ],
      invoices: [
        { invoiceNumber: "1-001", syncKey: "inv-a", legacyId: 50, legacyBidderId: 10 },
        { invoiceNumber: "1-002", syncKey: "inv-b", legacyId: 51, legacyBidderId: 10 },
      ],
    };

    it("moving a sale to another invoice is a change", () => {
      const next = structuredClone(linked);
      next.sales[0].legacyInvoiceId = 51;
      expect(eventSnapshotsContentEqual(linked, next)).toBe(false);
    });

    it("removing a $0 line from its invoice is a change", () => {
      const before = structuredClone(linked);
      before.sales[0].amount = 0;
      const after = structuredClone(before);
      delete after.sales[0].legacyInvoiceId;
      expect(eventSnapshotsContentEqual(before, after)).toBe(false);
    });

    it("linking a lot to a consignor is a change", () => {
      const next = structuredClone(linked);
      next.lots[0].legacyConsignorId = 30;
      expect(eventSnapshotsContentEqual(linked, next)).toBe(false);
    });

    it("changing a sale's consignor is a change", () => {
      const next = structuredClone(linked);
      next.sales[0].legacyConsignorId = 31;
      expect(eventSnapshotsContentEqual(linked, next)).toBe(false);
    });

    it("an idle re-export from another device with different local ids is unchanged", () => {
      const other = structuredClone(linked);
      other.exportDate = "2026-01-01T00:05:00.000Z";
      const shift = (n: unknown) => (n as number) + 1000;
      for (const b of other.bidders) b.legacyId = shift(b.legacyId);
      for (const c of other.consignors) c.legacyId = shift(c.legacyId);
      for (const l of other.lots) l.legacyId = shift(l.legacyId);
      for (const inv of other.invoices) {
        inv.legacyId = shift(inv.legacyId);
        inv.legacyBidderId = shift(inv.legacyBidderId);
      }
      for (const sale of other.sales) {
        sale.legacyId = shift(sale.legacyId);
        sale.legacyLotId = shift(sale.legacyLotId);
        sale.legacyBidderId = shift(sale.legacyBidderId);
        sale.legacyConsignorId = shift(sale.legacyConsignorId);
        sale.legacyInvoiceId = shift(sale.legacyInvoiceId);
      }
      expect(eventSnapshotsContentEqual(linked, other)).toBe(true);
    });

    it("a link to a missing record differs from a link to a real one", () => {
      const next = structuredClone(linked);
      next.sales[0].legacyInvoiceId = 999;
      expect(eventSnapshotsContentEqual(linked, next)).toBe(false);
    });

    it("tolerates payloads without arrays or with non-object entries", () => {
      expect(eventSnapshotsContentEqual(null, null)).toBe(true);
      expect(eventSnapshotsContentEqual({ sales: [1, null] }, { sales: [1, null] })).toBe(
        true
      );
      expect(eventSnapshotsContentEqual({ sales: [1] }, { sales: [2] })).toBe(false);
    });
  });
});
