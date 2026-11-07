import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import type { AuctionEvent, Bidder, Invoice, MasterBidder } from "@/lib/db";
import { ensureSettingsRow } from "@/lib/settings";
import {
  buildBidderStatement,
  buildBidderStatementPdf,
  listEventsForMasterBidder,
  loadBidderStatement,
  paymentMethodLabel,
} from "@/lib/services/combinedBidderStatement";

const now = new Date("2026-10-01T00:00:00Z");

const master: MasterBidder = {
  id: 1,
  syncKey: "m-sam",
  firstName: "Sam",
  lastName: "Buyer",
  mailingAddress: "1 Main St\nTown ST 00000",
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
  extra: Partial<Bidder> = {}
): Bidder {
  return {
    id,
    eventId,
    paddleNumber: paddle,
    firstName: "Sam",
    lastName: "Buyer",
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function invoice(
  id: number,
  eventId: number,
  bidderId: number,
  num: string,
  total: number,
  status: Invoice["status"] = "unpaid",
  extra: Partial<Invoice> = {}
): Invoice {
  return {
    id,
    eventId,
    bidderId,
    invoiceNumber: num,
    subtotal: total,
    buyersPremiumAmount: 0,
    taxAmount: 0,
    total,
    status,
    generatedAt: now,
    ...extra,
  };
}

describe("buildBidderStatement", () => {
  it("groups one bidder's invoices by auction with paid and balance due", () => {
    const sam1 = bidder(11, 1, 5, { masterSyncKey: "m-sam" });
    const other1 = bidder(12, 1, 6);
    // Different paddle in the second auction.
    const sam2 = bidder(21, 2, 9, { masterSyncKey: "m-sam" });

    const result = buildBidderStatement(master, [
      {
        event: event(1, "Spring sale"),
        bidders: [sam1, other1],
        invoices: [
          invoice(1, 1, 11, "10", 100, "paid", { paymentMethod: "cash" }),
          invoice(2, 1, 11, "2", 50.25),
          invoice(3, 1, 12, "3", 999),
        ],
      },
      {
        event: event(2, "Fall sale"),
        bidders: [sam2],
        invoices: [invoice(4, 2, 21, "1", 200)],
      },
    ]);

    expect(result.sections).toHaveLength(2);
    const [s1, s2] = result.sections;
    // Sorted by invoice number; the other bidder's invoice is not included.
    expect(s1!.lines.map((l) => l.invoiceNumber)).toEqual(["2", "10"]);
    expect(s1!.lines.map((l) => l.paddleNumber)).toEqual([5, 5]);
    expect(s1!).toMatchObject({ invoiced: 150.25, paid: 100, due: 50.25 });
    expect(s2!.bidders.map((b) => b.paddleNumber)).toEqual([9]);
    expect(s2!).toMatchObject({ invoiced: 200, paid: 0, due: 200 });
    expect(result.totals).toEqual([
      { currencySymbol: "$", invoiced: 350.25, paid: 100, due: 250.25 },
    ]);
  });

  it("includes every event bidder linked to the Directory entry", () => {
    const samA = bidder(11, 1, 5, { masterSyncKey: "m-sam" });
    const samB = bidder(13, 1, 8, { masterSyncKey: "m-sam" });
    const result = buildBidderStatement(master, [
      {
        event: event(1, "Spring sale"),
        bidders: [samA, bidder(12, 1, 6), samB],
        invoices: [
          invoice(1, 1, 11, "1", 10, "paid"),
          invoice(2, 1, 12, "2", 999),
          invoice(3, 1, 13, "3", 20),
        ],
      },
    ]);
    expect(result.sections[0]!.lines.map((l) => [l.invoiceNumber, l.paddleNumber])).toEqual([
      ["1", 5],
      ["3", 8],
    ]);
    expect(result.totals[0]).toMatchObject({ invoiced: 30, paid: 10, due: 20 });
  });

  it("leaves out auctions where the bidder is not linked", () => {
    const result = buildBidderStatement(master, [
      {
        event: event(1, "A"),
        bidders: [bidder(11, 1, 5)],
        invoices: [invoice(1, 1, 11, "1", 100)],
      },
    ]);
    expect(result.sections).toEqual([]);
    expect(result.totals).toEqual([]);
  });

  it("keeps a registered auction with no invoices, at zero", () => {
    const result = buildBidderStatement(master, [
      {
        event: event(1, "A"),
        bidders: [bidder(11, 1, 5, { masterSyncKey: "m-sam" })],
        invoices: [],
      },
    ]);
    expect(result.sections[0]).toMatchObject({ invoiced: 0, paid: 0, due: 0 });
    expect(result.sections[0]!.lines).toEqual([]);
  });

  it("totals each currency separately", () => {
    const result = buildBidderStatement(master, [
      {
        event: event(1, "US"),
        bidders: [bidder(11, 1, 1, { masterSyncKey: "m-sam" })],
        invoices: [invoice(1, 1, 11, "1", 10)],
      },
      {
        event: event(2, "UK", "£"),
        bidders: [bidder(21, 2, 1, { masterSyncKey: "m-sam" })],
        invoices: [invoice(2, 2, 21, "1", 20, "paid")],
      },
    ]);
    expect(result.totals.map((t) => [t.currencySymbol, t.paid, t.due])).toEqual([
      ["$", 0, 10],
      ["£", 20, 0],
    ]);
  });

  it("labels payment methods", () => {
    expect(paymentMethodLabel("credit_card")).toBe("Credit Card");
    expect(paymentMethodLabel(undefined)).toBeUndefined();
  });

  it("builds a PDF", () => {
    const statement = buildBidderStatement(master, [
      {
        event: event(1, "A"),
        bidders: [bidder(11, 1, 5, { masterSyncKey: "m-sam" })],
        invoices: [
          invoice(1, 1, 11, "1", 100, "paid", {
            paymentMethod: "check",
            paymentDate: now,
          }),
          invoice(2, 1, 11, "2", 40),
        ],
      },
    ]);
    const doc = buildBidderStatementPdf(master, statement);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});

describe("loading from the local database", () => {
  let db: AuctionDB;

  beforeEach(async () => {
    db = new AuctionDB(`bstmt_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await ensureSettingsRow(db);
  });

  afterEach(async () => {
    db.close();
    await Dexie.delete(db.name);
  });

  it("lists linked auctions and loads only the selected ones", async () => {
    const { id: _a, ...a } = event(1, "Older");
    const { id: _b, ...b } = event(2, "Newer");
    const { id: _c, ...c } = event(3, "Not theirs");
    const ea = (await db.events.add(a)) as number;
    const eb = (await db.events.add(b)) as number;
    const ec = (await db.events.add(c)) as number;
    const add = async (
      eventId: number,
      link: boolean,
      total: number,
      status: Invoice["status"]
    ) => {
      const { id: _x, ...bd } = bidder(0, eventId, 1, {
        masterSyncKey: link ? "m-sam" : undefined,
      });
      const bidderId = (await db.bidders.add(bd)) as number;
      const { id: _i, ...inv } = invoice(0, eventId, bidderId, "1", total, status);
      await db.invoices.add(inv);
    };
    await add(ea, true, 100, "paid");
    await add(eb, true, 200, "unpaid");
    await add(ec, false, 400, "unpaid");

    const listed = await listEventsForMasterBidder(db, "m-sam");
    expect(listed.map((e) => e.name)).toEqual(["Newer", "Older"]);

    const all = await loadBidderStatement(db, master, [eb, ea]);
    // Oldest auction first on the statement.
    expect(all.sections.map((s) => s.event.name)).toEqual(["Older", "Newer"]);
    expect(all.totals[0]).toMatchObject({ invoiced: 300, paid: 100, due: 200 });

    const one = await loadBidderStatement(db, master, [eb]);
    expect(one.sections.map((s) => s.event.name)).toEqual(["Newer"]);
  });
});
