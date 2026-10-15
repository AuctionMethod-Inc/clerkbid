import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import { mutateWithParentEventTouch } from "@/lib/db/mutateWithParentEventTouch";
import {
  eventRosterNumberTakenByAnother,
  rosterNumberChanged,
} from "@/lib/roster/eventNumberConflict";

let db: AuctionDB;
let eventId: number;

beforeEach(async () => {
  db = new AuctionDB(`paddle_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  eventId = (await db.events.add({
    name: "E",
    organizationName: "O",
    taxRate: 0,
    buyersPremiumRate: 0,
    defaultConsignorCommissionRate: 0,
    currencySymbol: "$",
    syncId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    createdAt: new Date(),
    updatedAt: new Date(),
  })) as number;
});

afterEach(async () => {
  db.close();
  await Dexie.delete(db.name);
});

describe("edit registered bidder contact fields", () => {
  it("updates address and resale without treating the same paddle as taken", async () => {
    const now = new Date();
    const id = (await db.bidders.add({
      eventId,
      paddleNumber: 12,
      firstName: "Ada",
      lastName: "Lovelace",
      createdAt: now,
      updatedAt: now,
    })) as number;

    const eventBidders = await db.bidders.where("eventId").equals(eventId).toArray();
    const paddle = 12;
    expect(rosterNumberChanged(12, paddle)).toBe(false);
    expect(
      eventRosterNumberTakenByAnother(
        eventBidders.map((b) => ({ id: b.id, number: b.paddleNumber })),
        paddle,
        id
      )
    ).toBe(false);

    const existing = await db.bidders.get(id);
    expect(existing).toBeTruthy();
    await mutateWithParentEventTouch(db, eventId, "bidders", async () => {
      await db.bidders.put({
        ...existing!,
        mailingAddress: "1 Market St",
        resaleNumber: "RS-9",
        updatedAt: new Date(),
      });
    });

    const saved = await db.bidders.get(id);
    expect(saved?.paddleNumber).toBe(12);
    expect(saved?.mailingAddress).toBe("1 Market St");
    expect(saved?.resaleNumber).toBe("RS-9");
  });

  it("old compound-index first() check falsely blocks an edit when another row shares the paddle", async () => {
    const now = new Date();
    await db.bidders.add({
      eventId,
      paddleNumber: 5,
      firstName: "A",
      lastName: "One",
      createdAt: now,
      updatedAt: now,
    });
    const id2 = (await db.bidders.add({
      eventId,
      paddleNumber: 5,
      firstName: "B",
      lastName: "Two",
      createdAt: now,
      updatedAt: now,
    })) as number;

    const taken = await db.bidders
      .where("[eventId+paddleNumber]")
      .equals([eventId, 5])
      .first();
    const oldCheckBlocks =
      taken != null && (typeof id2 !== "number" || taken.id !== id2);
    expect(oldCheckBlocks).toBe(true);
    expect(rosterNumberChanged(5, 5)).toBe(false);
  });
});
