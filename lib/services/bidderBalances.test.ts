import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import type { AuctionEvent, Bidder, Invoice, MasterBidder } from "@/lib/db";
import { ensureSettingsRow } from "@/lib/settings";
import {
  bidderBalanceCsvRows,
  buildBidderBalances,
  buildBidderBalancesPdf,
  listEventsForBalances,
  loadBidderBalances,
} from "@/lib/services/bidderBalances";

const now = new Date("2026-10-01T00:00:00Z");

const sam: MasterBidder = {
  id: 1,
  syncKey: "m-sam",
  firstName: "Sam",
  lastName: "Buyer",
  createdAt: now,
  updatedAt: now,
};

function event(id: number, name: string, sym = "$"): AuctionEvent {
  return {
    id,
    name,
    organizationName: "Org",
    taxRate: 0,
    buyersPremiumRate: 0,
    defaultConsignorCommissionRate: 0,
    currencySymbol: sym,
    syncId: `sync-${id}`,
    createdAt: new Date(now.getTime() + id * 86_400_000),
    updatedAt: now,
  };
}

function bidder(
  id: number,
  eventId: number,
  paddle: number,
  first: string,
  last: string,
  extra: Partial<Bidder> = {}
): Bidder {
  return {
    id,
    eventId,
    paddleNumber: paddle,
    firstName: first,
    lastName: last,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function invoice(
  id: number,
  eventId: number,
  bidderId: number,
  total: number,
  status: Invoice["status"] = "unpaid"
): Invoice {
  return {
    id,
    eventId,
    bidderId,
    invoiceNumber: String(id),
    subtotal: total,
    buyersPremiumAmount: 0,
    taxAmount: 0,
    total,
    status,
    generatedAt: now,
  };
}

describe("buildBidderBalances", () => {
  it("adds up a Directory bidder across auctions and keeps others per auction", () => {
    const result = buildBidderBalances(
      [
        {
          event: event(1, "Spring"),
          bidders: [
            bidder(11, 1, 5, "Sam", "Buyer", { masterSyncKey: "m-sam" }),
            bidder(12, 1, 6, "Ann", "Able"),
          ],
          invoices: [
            invoice(1, 1, 11, 100, "paid"),
            invoice(2, 1, 11, 50.5),
            invoice(3, 1, 12, 30),
          ],
        },
        {
          event: event(2, "Fall"),
          bidders: [
            bidder(21, 2, 9, "Sam", "Buyer", { masterSyncKey: "m-sam" }),
            // Same name, not linked: a separate row.
            bidder(22, 2, 7, "Ann", "Able"),
          ],
          invoices: [invoice(4, 2, 21, 200), invoice(5, 2, 22, 40, "paid")],
        },
      ],
      [sam]
    );

    expect(
      result.rows.map((r) => [r.name, r.inDirectory, r.paddles, r.invoiced, r.paid, r.due])
    ).toEqual([
      ["Ann Able", false, ["Spring #6"], 30, 0, 30],
      ["Ann Able", false, ["Fall #7"], 40, 40, 0],
      ["Sam Buyer", true, ["Spring #5", "Fall #9"], 350.5, 100, 250.5],
    ]);
    expect(result.rows.find((r) => r.inDirectory)!.invoiceCount).toBe(3);
    expect(result.totals).toEqual([
      { currencySymbol: "$", invoiced: 420.5, paid: 140, due: 280.5 },
    ]);
  });

  it("filters to bidders with a balance due, totals follow the filter", () => {
    const result = buildBidderBalances(
      [
        {
          event: event(1, "Spring"),
          bidders: [bidder(11, 1, 1, "Paid", "Up"), bidder(12, 1, 2, "Owes", "Money")],
          invoices: [invoice(1, 1, 11, 10, "paid"), invoice(2, 1, 12, 25)],
        },
      ],
      [],
      { unpaidOnly: true }
    );
    expect(result.rows.map((r) => r.name)).toEqual(["Owes Money"]);
    expect(result.totals).toEqual([
      { currencySymbol: "$", invoiced: 25, paid: 0, due: 25 },
    ]);
  });

  it("leaves out bidders with no invoices and invoices with no bidder", () => {
    const result = buildBidderBalances(
      [
        {
          event: event(1, "Spring"),
          bidders: [bidder(11, 1, 1, "No", "Invoices")],
          invoices: [invoice(1, 1, 99, 10)],
        },
      ],
      []
    );
    expect(result.rows).toEqual([]);
    expect(result.totals).toEqual([]);
  });

  it("treats a link to a missing Directory entry as not linked", () => {
    const result = buildBidderBalances(
      [
        {
          event: event(1, "Spring"),
          bidders: [bidder(11, 1, 1, "Sam", "Buyer", { masterSyncKey: "gone" })],
          invoices: [invoice(1, 1, 11, 10)],
        },
      ],
      [sam]
    );
    expect(result.rows[0]).toMatchObject({ inDirectory: false, name: "Sam Buyer" });
  });

  it("keeps currencies apart", () => {
    const result = buildBidderBalances(
      [
        {
          event: event(1, "US"),
          bidders: [bidder(11, 1, 1, "Sam", "Buyer", { masterSyncKey: "m-sam" })],
          invoices: [invoice(1, 1, 11, 10)],
        },
        {
          event: event(2, "UK", "£"),
          bidders: [bidder(21, 2, 1, "Sam", "Buyer", { masterSyncKey: "m-sam" })],
          invoices: [invoice(2, 2, 21, 20)],
        },
      ],
      [sam]
    );
    expect(result.rows.map((r) => [r.currencySymbol, r.due])).toEqual([
      ["$", 10],
      ["£", 20],
    ]);
    expect(new Set(result.rows.map((r) => r.key)).size).toBe(2);
    expect(result.totals.map((t) => t.currencySymbol)).toEqual(["$", "£"]);
  });

  it("builds CSV rows and a PDF", () => {
    const result = buildBidderBalances(
      [
        {
          event: event(1, "Spring"),
          bidders: [
            bidder(11, 1, 5, "Sam", "Buyer", { masterSyncKey: "m-sam" }),
            bidder(12, 1, 6, "Ann", "Able"),
          ],
          invoices: [invoice(1, 1, 11, 100, "paid"), invoice(2, 1, 12, 12.5)],
        },
      ],
      [sam]
    );
    expect(bidderBalanceCsvRows(result)).toEqual([
      ["Ann Able", "no", "Spring #6", 1, "$", "12.50", "0.00", "12.50"],
      ["Sam Buyer", "yes", "Spring #5", 1, "$", "100.00", "100.00", "0.00"],
    ]);
    const doc = buildBidderBalancesPdf(result, {
      organizationName: "Org",
      auctionNames: ["Spring"],
    });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});

describe("loading from the local database", () => {
  let db: AuctionDB;

  beforeEach(async () => {
    db = new AuctionDB(`bal_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await ensureSettingsRow(db);
  });

  afterEach(async () => {
    db.close();
    await Dexie.delete(db.name);
  });

  it("lists every auction and loads only the selected ones", async () => {
    await db.masterBidders.add({ ...sam, id: undefined });
    const { id: _a, ...a } = event(1, "Older");
    const { id: _b, ...b } = event(2, "Newer");
    const ea = (await db.events.add(a)) as number;
    const eb = (await db.events.add(b)) as number;
    const add = async (eventId: number, total: number, status: Invoice["status"]) => {
      const { id: _x, ...bd } = bidder(0, eventId, 1, "Sam", "Buyer", {
        masterSyncKey: "m-sam",
      });
      const bidderId = (await db.bidders.add(bd)) as number;
      const { id: _i, ...inv } = invoice(0, eventId, bidderId, total, status);
      await db.invoices.add(inv);
    };
    await add(ea, 100, "paid");
    await add(eb, 200, "unpaid");

    const listed = await listEventsForBalances(db);
    expect(listed.map((e) => e.name)).toEqual(["Newer", "Older"]);

    const all = await loadBidderBalances(db, [ea, eb]);
    expect(all.rows).toHaveLength(1);
    expect(all.rows[0]).toMatchObject({ invoiced: 300, paid: 100, due: 200 });

    const unpaid = await loadBidderBalances(db, [ea], { unpaidOnly: true });
    expect(unpaid.rows).toEqual([]);
  });
});
