import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import type { AuctionEvent, Consignor, Lot, MasterConsignor, Sale } from "@/lib/db";
import { ensureSettingsRow } from "@/lib/settings";
import {
  buildCombinedConsignorStatementPdf,
  buildCombinedStatement,
  listEventsForMasterConsignor,
  loadCombinedStatement,
} from "@/lib/services/combinedConsignorStatement";

const now = new Date("2026-10-01T00:00:00Z");

const master: MasterConsignor = {
  id: 1,
  syncKey: "m-jane",
  name: "Jane Seller",
  mailingAddress: "1 Main St\nTown ST 00000",
  createdAt: now,
  updatedAt: now,
};

function event(id: number, name: string, rate: number, sym = "$"): AuctionEvent {
  return {
    id,
    name,
    organizationName: "Org",
    taxRate: 0,
    buyersPremiumRate: 0,
    defaultConsignorCommissionRate: rate,
    currencySymbol: sym,
    syncId: `sync-${id}`,
    createdAt: new Date(now.getTime() + id * 86_400_000),
    updatedAt: now,
  };
}

function consignor(
  id: number,
  eventId: number,
  num: number,
  name: string,
  extra: Partial<Consignor> = {}
): Consignor {
  return {
    id,
    eventId,
    consignorNumber: num,
    name,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

function lot(id: number, eventId: number, n: string, consignorId?: number): Lot {
  return {
    id,
    eventId,
    baseLotNumber: parseInt(n, 10),
    lotSuffix: "",
    displayLotNumber: n,
    description: `Lot ${n}`,
    consignorId,
    quantity: 1,
    status: "sold",
    createdAt: now,
    updatedAt: now,
  };
}

function sale(
  id: number,
  eventId: number,
  lotId: number,
  n: string,
  amount: number,
  consignorId?: number
): Sale {
  return {
    id,
    eventId,
    lotId,
    bidderId: 1,
    displayLotNumber: n,
    paddleNumber: 1,
    description: `Lot ${n}`,
    consignorId,
    quantity: 1,
    amount,
    clerkInitials: "AB",
    createdAt: now,
  };
}

describe("buildCombinedStatement", () => {
  it("groups one consignor's sold lots by auction with a grand total", () => {
    const e1 = event(1, "Spring sale", 0.1);
    const e2 = event(2, "Fall sale", 0.2);
    const jane1 = consignor(11, 1, 5, "Jane Seller", { masterSyncKey: "m-jane" });
    const other1 = consignor(12, 1, 6, "Bob");
    // Different consignor number in the second auction, own rate override.
    const jane2 = consignor(21, 2, 9, "Jane Seller", {
      masterSyncKey: "m-jane",
      commissionRate: 0.15,
    });

    const result = buildCombinedStatement(master, [
      {
        event: e1,
        consignors: [jane1, other1],
        lots: [lot(1, 1, "10", 11), lot(2, 1, "2", 11), lot(3, 1, "3", 12)],
        sales: [
          sale(1, 1, 1, "10", 100, 11),
          sale(2, 1, 2, "2", 50, 11),
          sale(3, 1, 3, "3", 999, 12),
        ],
      },
      {
        event: e2,
        consignors: [jane2],
        lots: [lot(4, 2, "1", 21)],
        sales: [sale(4, 2, 4, "1", 200, 21)],
      },
    ]);

    expect(result.sections).toHaveLength(2);
    const [s1, s2] = result.sections;
    expect(s1!.consignor.consignorNumber).toBe(5);
    // Sorted by lot number; Bob's lot is not included.
    expect(s1!.lines.map((l) => l.lot)).toEqual(["2", "10"]);
    expect(s1!).toMatchObject({ hammer: 150, commission: 15, net: 135 });
    expect(s2!.consignor.consignorNumber).toBe(9);
    expect(s2!.lines[0]).toMatchObject({ rate: 0.15, commission: 30, net: 170 });
    expect(result.totals).toEqual([
      { currencySymbol: "$", hammer: 350, commission: 45, net: 305 },
    ]);
  });

  it("leaves out auctions where the consignor is not registered", () => {
    const result = buildCombinedStatement(master, [
      {
        event: event(1, "A", 0.1),
        consignors: [consignor(11, 1, 5, "Jane Seller")],
        lots: [lot(1, 1, "1", 11)],
        sales: [sale(1, 1, 1, "1", 100, 11)],
      },
    ]);
    expect(result.sections).toEqual([]);
    expect(result.totals).toEqual([]);
  });

  it("keeps a registered auction with no sales, at zero", () => {
    const result = buildCombinedStatement(master, [
      {
        event: event(1, "A", 0.1),
        consignors: [consignor(11, 1, 5, "Jane", { masterSyncKey: "m-jane" })],
        lots: [],
        sales: [],
      },
    ]);
    expect(result.sections[0]).toMatchObject({ hammer: 0, commission: 0, net: 0 });
    expect(result.sections[0]!.lines).toEqual([]);
  });

  it("totals each currency separately", () => {
    const result = buildCombinedStatement(master, [
      {
        event: event(1, "US", 0),
        consignors: [consignor(11, 1, 1, "Jane", { masterSyncKey: "m-jane" })],
        lots: [lot(1, 1, "1", 11)],
        sales: [sale(1, 1, 1, "1", 10, 11)],
      },
      {
        event: event(2, "UK", 0, "£"),
        consignors: [consignor(21, 2, 1, "Jane", { masterSyncKey: "m-jane" })],
        lots: [lot(2, 2, "1", 21)],
        sales: [sale(2, 2, 2, "1", 20, 21)],
      },
    ]);
    expect(result.totals.map((t) => [t.currencySymbol, t.net])).toEqual([
      ["$", 10],
      ["£", 20],
    ]);
  });

  it("builds a PDF", () => {
    const statement = buildCombinedStatement(master, [
      {
        event: event(1, "A", 0.1),
        consignors: [consignor(11, 1, 5, "Jane", { masterSyncKey: "m-jane" })],
        lots: [lot(1, 1, "1", 11)],
        sales: [sale(1, 1, 1, "1", 100, 11)],
      },
    ]);
    const doc = buildCombinedConsignorStatementPdf(master, statement);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});

describe("loading from the local database", () => {
  let db: AuctionDB;

  beforeEach(async () => {
    db = new AuctionDB(`stmt_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    await ensureSettingsRow(db);
  });

  afterEach(async () => {
    db.close();
    await Dexie.delete(db.name);
  });

  it("lists linked auctions and loads only the selected ones", async () => {
    const { id: _a, ...a } = event(1, "Older", 0.1);
    const { id: _b, ...b } = event(2, "Newer", 0.1);
    const { id: _c, ...c } = event(3, "Not hers", 0.1);
    const ea = (await db.events.add(a)) as number;
    const eb = (await db.events.add(b)) as number;
    const ec = (await db.events.add(c)) as number;
    const add = async (eventId: number, link: boolean, amount: number) => {
      const cid = (await db.consignors.add({
        eventId,
        consignorNumber: 1,
        name: "Jane",
        masterSyncKey: link ? "m-jane" : undefined,
        createdAt: now,
        updatedAt: now,
      })) as number;
      const { id: _l, ...l } = lot(0, eventId, "1", cid);
      const lotId = (await db.lots.add(l)) as number;
      const { id: _s, ...s } = sale(0, eventId, lotId, "1", amount, cid);
      await db.sales.add(s);
    };
    await add(ea, true, 100);
    await add(eb, true, 200);
    await add(ec, false, 400);

    const listed = await listEventsForMasterConsignor(db, "m-jane");
    expect(listed.map((e) => e.name)).toEqual(["Newer", "Older"]);

    const all = await loadCombinedStatement(db, master, [eb, ea]);
    // Oldest auction first on the statement.
    expect(all.sections.map((s) => s.event.name)).toEqual(["Older", "Newer"]);
    expect(all.totals[0]).toMatchObject({ hammer: 300, net: 270 });

    const one = await loadCombinedStatement(db, master, [eb]);
    expect(one.sections.map((s) => s.event.name)).toEqual(["Newer"]);
  });
});
