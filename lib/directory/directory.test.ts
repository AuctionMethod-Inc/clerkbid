import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import { seedDirectoryFromEvents } from "@/lib/directory/seed";
import { mergeDirectorySnapshot } from "@/lib/directory/merge";
import {
  consolidateMasterBiddersByEmail,
  findOrCreateMasterBidder,
  upsertMasterBidder,
} from "@/lib/directory/upsert";
import { ensureSettingsRow } from "@/lib/settings";
import { DIRECTORY_EXPORT_VERSION } from "@/lib/directory/payload";

let db: AuctionDB;

beforeEach(async () => {
  const uid = `dir_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  db = new AuctionDB(uid);
  await ensureSettingsRow(db);
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

describe("directory seed and upsert", () => {
  it("matches existing event bidders by email into one master", async () => {
    const eventId = (await db.events.add({
      name: "A",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    const event2 = (await db.events.add({
      name: "B",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-8ddd-ffffffffffff",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    const now = new Date();
    await db.bidders.add({
      eventId,
      paddleNumber: 1,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.com",
      createdAt: now,
      updatedAt: now,
    });
    await db.bidders.add({
      eventId: event2,
      paddleNumber: 9,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.com",
      createdAt: now,
      updatedAt: now,
    });

    await seedDirectoryFromEvents(db);
    const masters = await db.masterBidders.toArray();
    expect(masters).toHaveLength(1);
    const linked = await db.bidders.toArray();
    expect(linked.every((b) => b.masterSyncKey === masters[0]?.syncKey)).toBe(
      true
    );
  });

  it("does not merge name-only duplicates", async () => {
    const eventId = (await db.events.add({
      name: "A",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    const now = new Date();
    await db.bidders.add({
      eventId,
      paddleNumber: 1,
      firstName: "Pat",
      lastName: "Lee",
      createdAt: now,
      updatedAt: now,
    });
    await db.bidders.add({
      eventId,
      paddleNumber: 2,
      firstName: "Pat",
      lastName: "Lee",
      createdAt: now,
      updatedAt: now,
    });
    await seedDirectoryFromEvents(db);
    expect(await db.masterBidders.count()).toBe(2);
  });

  it("findOrCreate reuses email match", async () => {
    const a = await findOrCreateMasterBidder(db, {
      firstName: "A",
      lastName: "B",
      email: "ab@x.com",
    });
    const b = await findOrCreateMasterBidder(db, {
      firstName: "Other",
      lastName: "Name",
      email: "ab@x.com",
    });
    expect(b.syncKey).toBe(a.syncKey);
    expect(await db.masterBidders.count()).toBe(1);
  });

  it("upsert updates existing master fields instead of creating a duplicate", async () => {
    const a = await upsertMasterBidder(db, {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.com",
      phone: "555-111-2222",
      mailingAddress: "1 Old St",
    });
    const b = await upsertMasterBidder(
      db,
      {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@x.com",
        phone: "555-999-8888",
        mailingAddress: "2 New Ave",
      },
      { preferredSyncKey: a.syncKey }
    );
    expect(b.syncKey).toBe(a.syncKey);
    expect(await db.masterBidders.count()).toBe(1);
    const row = await db.masterBidders.get(a.id!);
    expect(row?.phone).toBe("555-999-8888");
    expect(row?.mailingAddress).toBe("2 New Ave");
  });

  it("upsert by email merges preferredSyncKey into the email-canonical row", async () => {
    const byEmail = await upsertMasterBidder(db, {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.com",
      mailingAddress: "1 Old St",
    });
    const other = await upsertMasterBidder(db, {
      firstName: "Jane",
      lastName: "Doe",
      phone: "555-111-2222",
      mailingAddress: "orphan",
    });
    expect(await db.masterBidders.count()).toBe(2);

    const eventId = (await db.events.add({
      name: "A",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    await db.bidders.add({
      eventId,
      paddleNumber: 1,
      firstName: "Jane",
      lastName: "Doe",
      phone: "555-111-2222",
      masterSyncKey: other.syncKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const merged = await upsertMasterBidder(
      db,
      {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@x.com",
        phone: "555-999-0000",
        mailingAddress: "2 New Ave",
      },
      { preferredSyncKey: other.syncKey }
    );

    expect(merged.syncKey).toBe(byEmail.syncKey);
    expect(await db.masterBidders.count()).toBe(1);
    const linked = await db.bidders.toArray();
    expect(linked[0]?.masterSyncKey).toBe(byEmail.syncKey);
    const row = await db.masterBidders.where("syncKey").equals(byEmail.syncKey).first();
    expect(row?.mailingAddress).toBe("2 New Ave");
    expect(row?.phone).toBe("555-999-0000");
  });

  it("consolidateMasterBiddersByEmail removes email duplicates and re-points links", async () => {
    const older = await db.masterBidders.add({
      syncKey: "old-key",
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.com",
      mailingAddress: "Old",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.masterBidders.add({
      syncKey: "new-key",
      firstName: "Jane",
      lastName: "Doe",
      email: "Jane@x.com",
      mailingAddress: "New",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const eventId = (await db.events.add({
      name: "A",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    await db.bidders.add({
      eventId,
      paddleNumber: 1,
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@x.com",
      masterSyncKey: "old-key",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await consolidateMasterBiddersByEmail(db);
    expect(result.removed).toBe(1);
    expect(await db.masterBidders.count()).toBe(1);
    const remaining = await db.masterBidders.toArray();
    expect(remaining[0]?.syncKey).toBe("new-key");
    expect(remaining[0]?.mailingAddress).toBe("New");
    expect(await db.masterBidders.get(older as number)).toBeUndefined();
    const linked = await db.bidders.toArray();
    expect(linked[0]?.masterSyncKey).toBe("new-key");
  });

  it("consolidates phone duplicates when emails do not conflict", async () => {
    await db.masterBidders.add({
      syncKey: "a",
      firstName: "Jane",
      lastName: "Doe",
      phone: "(555) 111-2222",
      mailingAddress: "Old",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.masterBidders.add({
      syncKey: "b",
      firstName: "Jane",
      lastName: "Doe",
      phone: "5551112222",
      email: "jane@x.com",
      mailingAddress: "New",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      updatedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    const result = await consolidateMasterBiddersByEmail(db);
    expect(result.removed).toBe(1);
    expect(await db.masterBidders.count()).toBe(1);
    const row = await db.masterBidders.toArray();
    expect(row[0]?.email).toBe("jane@x.com");
    expect(row[0]?.mailingAddress).toBe("New");
  });

  it("does not merge same phone when emails differ", async () => {
    await db.masterBidders.add({
      syncKey: "a",
      firstName: "A",
      lastName: "One",
      phone: "5551112222",
      email: "a@x.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.masterBidders.add({
      syncKey: "b",
      firstName: "B",
      lastName: "Two",
      phone: "5551112222",
      email: "b@x.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await consolidateMasterBiddersByEmail(db);
    expect(result.removed).toBe(0);
    expect(await db.masterBidders.count()).toBe(2);
  });

  it("deleteMasterBidders removes masters and clears event links", async () => {
    const { deleteMasterBidders } = await import("@/lib/directory/upsert");
    await db.masterBidders.add({
      syncKey: "del-me",
      firstName: "Gone",
      lastName: "Bidder",
      email: "gone@x.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const eventId = (await db.events.add({
      name: "A",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    await db.bidders.add({
      eventId,
      paddleNumber: 1,
      firstName: "Gone",
      lastName: "Bidder",
      email: "gone@x.com",
      masterSyncKey: "del-me",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const n = await deleteMasterBidders(db, ["del-me"]);
    expect(n).toBe(1);
    expect(await db.masterBidders.count()).toBe(0);
    const bidder = await db.bidders.toArray();
    expect(bidder[0]?.masterSyncKey).toBeUndefined();
    expect(bidder[0]?.firstName).toBe("Gone");
  });
});

describe("replaceDirectorySnapshot", () => {
  it("replaces local masters and drops local-only orphans", async () => {
    const { replaceDirectorySnapshot } = await import("@/lib/directory/merge");
    await db.masterBidders.add({
      syncKey: "orphan",
      firstName: "Old",
      lastName: "Orphan",
      email: "orphan@x.com",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await db.masterBidders.add({
      syncKey: "keep",
      firstName: "Old",
      lastName: "Keep",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const eventId = (await db.events.add({
      name: "A",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-1ccc-8ddd-eeeeeeeeeeee",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    await db.bidders.add({
      eventId,
      paddleNumber: 1,
      firstName: "Old",
      lastName: "Orphan",
      masterSyncKey: "orphan",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await replaceDirectorySnapshot(db, {
      exportVersion: DIRECTORY_EXPORT_VERSION,
      exportDate: "2026-02-01T00:00:00.000Z",
      bidders: [
        {
          syncKey: "keep",
          firstName: "New",
          lastName: "Keep",
          mailingAddress: "1 Main",
          resaleNumber: "TX-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      consignors: [],
    });

    const masters = await db.masterBidders.toArray();
    expect(masters).toHaveLength(1);
    expect(masters[0]?.syncKey).toBe("keep");
    expect(masters[0]?.firstName).toBe("New");
    expect(masters[0]?.mailingAddress).toBe("1 Main");
    expect(masters[0]?.resaleNumber).toBe("TX-1");
    const bidder = await db.bidders.toArray();
    expect(bidder[0]?.masterSyncKey).toBeUndefined();
  });
});

describe("mergeDirectorySnapshot", () => {
  it("delegates to replace (full remote set wins)", async () => {
    await db.masterBidders.add({
      syncKey: "same",
      firstName: "Old",
      lastName: "Name",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const summary = await mergeDirectorySnapshot(db, {
      exportVersion: DIRECTORY_EXPORT_VERSION,
      exportDate: "2026-02-01T00:00:00.000Z",
      bidders: [
        {
          syncKey: "same",
          firstName: "New",
          lastName: "Name",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        {
          syncKey: "extra",
          firstName: "Ada",
          lastName: "Lovelace",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      consignors: [],
    });
    expect(summary.biddersAdded).toBe(2);
    expect(await db.masterBidders.count()).toBe(2);
    const same = await db.masterBidders.where("syncKey").equals("same").first();
    expect(same?.firstName).toBe("New");
  });
});

describe("CSV import transaction scope", () => {
  it("findOrCreateMasterBidder fails inside events+bidders-only transaction", async () => {
    const eventId = (await db.events.add({
      name: "A",
      organizationName: "Org",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;

    await expect(
      db.transaction("rw", [db.events, db.bidders], async () => {
        await findOrCreateMasterBidder(db, {
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
        });
      })
    ).rejects.toThrow(/objectStore|object store/i);

    // Import must include masterBidders in the same transaction.
    await db.transaction(
      "rw",
      [db.events, db.bidders, db.masterBidders],
      async () => {
        await db.events.update(eventId, { updatedAt: new Date() });
        const master = await findOrCreateMasterBidder(db, {
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
        });
        await db.bidders.add({
          eventId,
          paddleNumber: 101,
          firstName: "Jane",
          lastName: "Doe",
          email: "jane@example.com",
          masterSyncKey: master.syncKey,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    );

    expect(await db.bidders.count()).toBe(1);
    expect(await db.masterBidders.count()).toBe(1);
  });
});
