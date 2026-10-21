import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import { ensureSettingsRow } from "@/lib/settings";
import { copyBiddersFromEvent } from "@/lib/directory/copyBidders";
import { findOrCreateMasterBidder } from "@/lib/directory/upsert";

let db: AuctionDB;

beforeEach(async () => {
  const uid = `copy_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  db = new AuctionDB(uid);
  await ensureSettingsRow(db);
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

let syncSeq = 0;
async function addEvent(name: string): Promise<number> {
  syncSeq++;
  return (await db.events.add({
    name,
    organizationName: "Org",
    taxRate: 0,
    buyersPremiumRate: 0,
    defaultConsignorCommissionRate: 0,
    currencySymbol: "$",
    syncId: `aaaaaaaa-bbbb-1ccc-8ddd-${String(syncSeq).padStart(12, "0")}`,
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as number;
}

async function addBidder(
  eventId: number,
  paddleNumber: number,
  firstName: string,
  lastName: string,
  extra: { email?: string; phone?: string; linkMaster?: boolean } = {}
) {
  const now = new Date();
  const master = extra.linkMaster
    ? await findOrCreateMasterBidder(db, {
        firstName,
        lastName,
        email: extra.email,
        phone: extra.phone,
      })
    : undefined;
  await db.bidders.add({
    eventId,
    paddleNumber,
    firstName,
    lastName,
    email: extra.email,
    phone: extra.phone,
    masterSyncKey: master?.syncKey,
    createdAt: now,
    updatedAt: now,
  });
}

async function roster(eventId: number) {
  const rows = await db.bidders.where("eventId").equals(eventId).toArray();
  return rows
    .sort((a, b) => a.paddleNumber - b.paddleNumber)
    .map((b) => `${b.paddleNumber} ${b.firstName}`);
}

describe("copyBiddersFromEvent", () => {
  it("copies every bidder with their paddle numbers, linked to the Directory", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 5, "Ann", "A", { email: "ann@x.com", linkMaster: true });
    await addBidder(prev, 12, "Bob", "B", { phone: "555-123-4567" });

    const res = await copyBiddersFromEvent(db, {
      fromEventId: prev,
      toEventId: next,
      paddles: "keep",
    });

    expect(res).toEqual({ added: 2, skipped: 0, renumbered: [] });
    expect(await roster(next)).toEqual(["5 Ann", "12 Bob"]);
    const copied = await db.bidders.where("eventId").equals(next).toArray();
    const masters = await db.masterBidders.toArray();
    expect(masters).toHaveLength(2);
    for (const b of copied) {
      expect(masters.some((m) => m.syncKey === b.masterSyncKey)).toBe(true);
    }
    // Source roster untouched.
    expect(await roster(prev)).toEqual(["5 Ann", "12 Bob"]);
  });

  it("skips bidders already in the target event", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 1, "Ann", "A", { email: "ann@x.com", linkMaster: true });
    await addBidder(prev, 2, "Bob", "B", { phone: "555-123-4567" });
    await addBidder(prev, 3, "Cy", "C");
    // Ann registered here by email (unlinked), Bob by name + phone.
    await addBidder(next, 40, "Ann", "A", { email: "ANN@x.com" });
    await addBidder(next, 41, "Bob", "B", { phone: "(555) 123-4567" });

    const res = await copyBiddersFromEvent(db, {
      fromEventId: prev,
      toEventId: next,
      paddles: "keep",
    });

    expect(res.added).toBe(1);
    expect(res.skipped).toBe(2);
    expect(await roster(next)).toEqual(["3 Cy", "40 Ann", "41 Bob"]);
  });

  it("matches on name alone only when the bidder has no email or phone", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 1, "Ann", "A");
    await addBidder(prev, 2, "John", "Smith", { email: "john2@x.com" });
    await addBidder(next, 50, "ann", "a");
    await addBidder(next, 51, "John", "Smith", { email: "john1@x.com" });

    const res = await copyBiddersFromEvent(db, {
      fromEventId: prev,
      toEventId: next,
      paddles: "keep",
    });

    expect(res.added).toBe(1);
    expect(res.skipped).toBe(1);
    expect(await roster(next)).toEqual(["2 John", "50 ann", "51 John"]);
  });

  it("running it twice adds nobody the second time", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 1, "Ann", "A");
    await addBidder(prev, 2, "Bob", "B");
    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });
    const res = await copyBiddersFromEvent(db, {
      fromEventId: prev,
      toEventId: next,
      paddles: "keep",
    });
    expect(res).toEqual({ added: 0, skipped: 2, renumbered: [] });
    expect(await roster(next)).toEqual(["1 Ann", "2 Bob"]);
  });

  it("keep: a paddle already taken gets the next free number and is reported", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 7, "Ann", "A");
    await addBidder(prev, 9, "Bob", "B");
    await addBidder(prev, 20, "Cy", "C");
    // Paddle 7 came in from a CSV import for someone else.
    await addBidder(next, 7, "Zed", "Z");

    const res = await copyBiddersFromEvent(db, {
      fromEventId: prev,
      toEventId: next,
      paddles: "keep",
    });

    expect(res.added).toBe(3);
    expect(res.renumbered).toEqual([{ name: "Ann A", from: 7, to: 21 }]);
    expect(await roster(next)).toEqual(["7 Zed", "9 Bob", "20 Cy", "21 Ann"]);
  });

  it("renumber: numbers everyone from the next free paddle in paddle order", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 30, "Cy", "C");
    await addBidder(prev, 4, "Ann", "A");
    await addBidder(prev, 12, "Bob", "B");
    await addBidder(next, 1, "Zed", "Z");

    const res = await copyBiddersFromEvent(db, {
      fromEventId: prev,
      toEventId: next,
      paddles: "renumber",
    });

    expect(res).toEqual({ added: 3, skipped: 0, renumbered: [] });
    expect(await roster(next)).toEqual(["1 Zed", "2 Ann", "3 Bob", "4 Cy"]);
  });

  it("renumber into an empty event starts at 1", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 101, "Ann", "A");
    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "renumber" });
    expect(await roster(next)).toEqual(["1 Ann"]);
  });

  it("bumps the target event's updatedAt so the copy is pushed to the cloud", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await db.events.update(next, { updatedAt: new Date(2000, 0, 1) });
    await addBidder(prev, 1, "Ann", "A");
    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });
    const ev = await db.events.get(next);
    expect(ev!.updatedAt.getTime()).toBeGreaterThan(new Date(2000, 0, 1).getTime());
  });

  it("copying an event onto itself does nothing", async () => {
    const prev = await addEvent("Prev");
    await addBidder(prev, 1, "Ann", "A");
    const res = await copyBiddersFromEvent(db, {
      fromEventId: prev,
      toEventId: prev,
      paddles: "keep",
    });
    expect(res).toEqual({ added: 0, skipped: 0, renumbered: [] });
    expect(await roster(prev)).toEqual(["1 Ann"]);
  });
  it("takes contact details from the Directory entry when it was edited after the old auction", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 5, "Ann", "A", {
      email: "ann@x.com",
      phone: "555-000-1111",
      linkMaster: true,
    });
    const master = (await db.masterBidders.toArray())[0]!;
    await db.masterBidders.update(master.id!, {
      phone: "555-999-2222",
      mailingAddress: "1 New St",
    });

    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });

    const [copied] = await db.bidders.where("eventId").equals(next).toArray();
    expect(copied).toMatchObject({
      firstName: "Ann",
      email: "ann@x.com",
      phone: "555-999-2222",
      mailingAddress: "1 New St",
      masterSyncKey: master.syncKey,
    });
  });
  it("keeps a field the Directory entry cleared blank on the copy", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 5, "Ann", "A", {
      email: "ann@x.com",
      phone: "555-000-1111",
      linkMaster: true,
    });
    await db.bidders.where("eventId").equals(prev).modify({ resaleNumber: "R-1" });
    const master = (await db.masterBidders.toArray())[0]!;
    await db.masterBidders.update(master.id!, { phone: undefined, resaleNumber: undefined });

    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });

    const [copied] = await db.bidders.where("eventId").equals(next).toArray();
    expect(copied!.phone).toBeUndefined();
    expect(copied!.resaleNumber).toBeUndefined();
    expect(copied!.email).toBe("ann@x.com");
  });

  it("keeps the bidder's own name when the Directory entry is shared", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    await addBidder(prev, 5, "Ann", "A", { email: "family@x.com", linkMaster: true });
    const master = (await db.masterBidders.toArray())[0]!;
    await db.masterBidders.update(master.id!, { firstName: "Bob" });

    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });

    expect(await roster(next)).toEqual(["5 Ann"]);
  });

  it("keeps an unlinked bidder's own contact details and does not link them to someone else's entry", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    const ann = await findOrCreateMasterBidder(db, {
      firstName: "Ann",
      lastName: "A",
      email: "family@x.com",
      phone: "555-000-1111",
      mailingAddress: "1 Ann St",
      resaleNumber: "R-ANN",
    });
    await addBidder(prev, 9, "Bob", "A", { email: "family@x.com", phone: "555-222-3333" });
    await db.bidders
      .where("eventId")
      .equals(prev)
      .modify({ mailingAddress: "2 Bob St", resaleNumber: undefined });

    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });

    const [copied] = await db.bidders.where("eventId").equals(next).toArray();
    expect(copied).toMatchObject({
      firstName: "Bob",
      email: "family@x.com",
      phone: "555-222-3333",
      mailingAddress: "2 Bob St",
    });
    expect(copied!.resaleNumber).toBeUndefined();
    expect(copied!.masterSyncKey).toBeUndefined();
    expect((await db.masterBidders.toArray()).map((m) => m.syncKey)).toEqual([ann.syncKey]);
  });

  it("copying on again from the new auction still keeps that bidder's own contact details", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    const third = await addEvent("Third");
    await findOrCreateMasterBidder(db, {
      firstName: "Ann",
      lastName: "A",
      email: "family@x.com",
      phone: "555-000-1111",
      mailingAddress: "1 Ann St",
      resaleNumber: "R-ANN",
    });
    await addBidder(prev, 9, "Bob", "A", { email: "family@x.com", phone: "555-222-3333" });

    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });
    await copyBiddersFromEvent(db, { fromEventId: next, toEventId: third, paddles: "keep" });

    const [copied] = await db.bidders.where("eventId").equals(third).toArray();
    expect(copied).toMatchObject({ firstName: "Bob", phone: "555-222-3333" });
    expect(copied!.mailingAddress).toBeUndefined();
    expect(copied!.resaleNumber).toBeUndefined();
  });

  it("a bidder already linked to an entry under another name keeps their own contact details", async () => {
    const prev = await addEvent("Prev");
    const next = await addEvent("Next");
    const ann = await findOrCreateMasterBidder(db, {
      firstName: "Ann",
      lastName: "A",
      email: "family@x.com",
      phone: "555-000-1111",
      resaleNumber: "R-ANN",
    });
    // Linked to Ann's entry when registered (CSV import matches on email).
    await addBidder(prev, 9, "Bob", "A", {
      email: "family@x.com",
      phone: "555-222-3333",
      linkMaster: true,
    });

    await copyBiddersFromEvent(db, { fromEventId: prev, toEventId: next, paddles: "keep" });

    const [copied] = await db.bidders.where("eventId").equals(next).toArray();
    expect(copied).toMatchObject({
      firstName: "Bob",
      phone: "555-222-3333",
      masterSyncKey: ann.syncKey,
    });
    expect(copied!.resaleNumber).toBeUndefined();
  });
});
