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
});
