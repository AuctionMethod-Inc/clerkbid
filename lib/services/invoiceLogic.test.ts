import "fake-indexeddb/auto";
import Dexie from "dexie";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { AuctionDB, type AuctionEvent, type Invoice } from "@/lib/db";
import {
  attachUnallocatedSalesToUnpaidInvoice,
  computeInvoiceFromSubtotal,
  computeInvoiceTotalsFromParts,
  effectiveInvoiceBuyersPremiumRate,
  effectiveInvoiceTaxRate,
  formatInvoiceNumber,
  recalculateAndPersistInvoice,
  resolveInvoiceForOpenDetail,
  roundMoney,
  upsertInvoiceForBidder,
} from "./invoiceLogic";

describe("roundMoney", () => {
  it("rounds to 2 decimals", () => {
    expect(roundMoney(10.005)).toBe(10.01);
    expect(roundMoney(10.004)).toBe(10);
  });
});

describe("computeInvoiceFromSubtotal", () => {
  it("applies tax", () => {
    const r = computeInvoiceFromSubtotal(100, 0.0875);
    expect(r.subtotal).toBe(100);
    expect(r.taxAmount).toBe(8.75);
    expect(r.total).toBe(108.75);
  });

  it("matches hammer aggregate with buyer’s premium before tax", () => {
    const hammerSubtotal = roundMoney(100 + 50);
    const bpRate = 0.1;
    const taxableSubtotal = roundMoney(hammerSubtotal * (1 + bpRate));
    expect(taxableSubtotal).toBe(165);
    const inv = computeInvoiceFromSubtotal(taxableSubtotal, 0.1);
    expect(inv.taxAmount).toBe(16.5);
    expect(inv.total).toBe(181.5);
  });
});

describe("formatInvoiceNumber", () => {
  it("pads sequence", () => {
    expect(formatInvoiceNumber(1, 1)).toBe("1-001");
    expect(formatInvoiceNumber(12, 42)).toBe("12-042");
  });
});

const baseEvent: AuctionEvent = {
  id: 1,
  name: "E",
  organizationName: "O",
  taxRate: 0.1,
  buyersPremiumRate: 0.1,
  defaultConsignorCommissionRate: 0,
  currencySymbol: "$",
  syncId: "x",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("computeInvoiceTotalsFromParts", () => {
  it("applies BP only to hammer; manual lines after BP, before tax", () => {
    const inv = {} as Invoice;
    const r = computeInvoiceTotalsFromParts(
      100,
      [{ id: "a", description: "Fee", amount: 10 }],
      inv,
      baseEvent
    );
    expect(r.subtotal).toBe(100);
    expect(r.buyersPremiumAmount).toBe(10);
    expect(r.taxAmount).toBe(12);
    expect(r.total).toBe(132);
  });

  it("supports negative manual lines and invoice rate overrides", () => {
    const inv = {
      buyersPremiumRate: 0.2,
      taxRate: 0.05,
    } as Invoice;
    const r = computeInvoiceTotalsFromParts(
      100,
      [{ id: "a", description: "Credit", amount: -15 }],
      inv,
      baseEvent
    );
    expect(r.buyersPremiumAmount).toBe(20);
    expect(roundMoney(100 + 20 - 15)).toBe(105);
    expect(r.taxAmount).toBe(5.25);
    expect(r.total).toBe(110.25);
  });
});

describe("effective invoice rates", () => {
  it("falls back to event when invoice override unset", () => {
    const inv = {} as Invoice;
    expect(effectiveInvoiceBuyersPremiumRate(inv, baseEvent)).toBe(0.1);
    expect(effectiveInvoiceTaxRate(inv, baseEvent)).toBe(0.1);
  });

  it("uses invoice numbers when set", () => {
    const inv = { buyersPremiumRate: 0.15, taxRate: 0.08 } as Invoice;
    expect(effectiveInvoiceBuyersPremiumRate(inv, baseEvent)).toBe(0.15);
    expect(effectiveInvoiceTaxRate(inv, baseEvent)).toBe(0.08);
  });

  it("coerces string overrides and whole percents in (1, 100]", () => {
    const inv = {
      buyersPremiumRate: "10" as unknown as number,
      taxRate: "8.75" as unknown as number,
    } as Invoice;
    expect(effectiveInvoiceBuyersPremiumRate(inv, baseEvent)).toBe(0.1);
    expect(effectiveInvoiceTaxRate(inv, baseEvent)).toBe(0.0875);
  });
});

describe("resolveInvoiceForOpenDetail", () => {
  let db: AuctionDB;
  let eventId: number;
  let bidderId: number;

  beforeEach(async () => {
    const uid = `inv_resolve_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    db = new AuctionDB(uid);
    eventId = (await db.events.add({
      name: "E",
      organizationName: "O",
      taxRate: 0,
      buyersPremiumRate: 0,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "evt-sync-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    bidderId = (await db.bidders.add({
      eventId,
      paddleNumber: 4,
      firstName: "A",
      lastName: "K",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
  });

  afterEach(async () => {
    db.close();
    await Dexie.delete(db.name);
  });

  it("finds invoice by syncKey when numeric id is stale", async () => {
    const sk = "inv-stable-key-99";
    const newId = (await db.invoices.add({
      eventId,
      bidderId,
      invoiceNumber: "4-006",
      subtotal: 600,
      buyersPremiumAmount: 0,
      taxAmount: 0,
      total: 600,
      status: "unpaid",
      generatedAt: new Date(),
      syncKey: sk,
    })) as number;

    const found = await resolveInvoiceForOpenDetail(db, eventId, {
      id: 99999,
      syncKey: sk,
      invoiceNumber: "4-006",
      bidderId,
    });
    expect(found?.id).toBe(newId);
    expect(found?.total).toBe(600);
  });

  it("falls back to invoiceNumber and bidderId when syncKey missing", async () => {
    const newId = (await db.invoices.add({
      eventId,
      bidderId,
      invoiceNumber: "1-002",
      subtotal: 10,
      buyersPremiumAmount: 0,
      taxAmount: 0,
      total: 10,
      status: "unpaid",
      generatedAt: new Date(),
    })) as number;

    const found = await resolveInvoiceForOpenDetail(db, eventId, {
      id: 88888,
      invoiceNumber: "1-002",
      bidderId,
    });
    expect(found?.id).toBe(newId);
  });
});

describe("recalculateAndPersistInvoice", () => {
  let db: AuctionDB;
  let eventId: number;
  let bidderId: number;
  let invoiceId: number;

  beforeEach(async () => {
    const uid = `inv_recalc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    db = new AuctionDB(uid);
    eventId = (await db.events.add({
      name: "E",
      organizationName: "O",
      taxRate: 0.1,
      buyersPremiumRate: 0.1,
      defaultConsignorCommissionRate: 0,
      currencySymbol: "$",
      syncId: "evt-sync-recalc",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    bidderId = (await db.bidders.add({
      eventId,
      paddleNumber: 4,
      firstName: "A",
      lastName: "K",
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
      status: "sold",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    invoiceId = (await db.invoices.add({
      eventId,
      bidderId,
      invoiceNumber: "1-001",
      subtotal: 100,
      buyersPremiumAmount: 10,
      taxAmount: 11,
      total: 121,
      status: "unpaid",
      generatedAt: new Date("2026-01-01T00:00:00.000Z"),
      syncKey: "inv-recalc-1",
    })) as number;
    await db.sales.add({
      eventId,
      lotId,
      bidderId,
      invoiceId,
      displayLotNumber: "1",
      paddleNumber: 4,
      description: "Lot",
      quantity: 1,
      amount: 100,
      clerkInitials: "DW",
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    db.close();
    await Dexie.delete(db.name);
  });

  it("does not write unpaid invoices when totals are already current", async () => {
    const event = await db.events.get(eventId);
    const before = await db.invoices.get(invoiceId);
    const wrote = await recalculateAndPersistInvoice(db, invoiceId, event!, {
      touchGeneratedAt: true,
    });
    expect(wrote).toBe(false);
    const after = await db.invoices.get(invoiceId);
    expect(after?.generatedAt.getTime()).toBe(before?.generatedAt.getTime());
    expect(after?.total).toBe(121);
  });

  it("returns unchanged when generating an unpaid invoice with no new sales", async () => {
    const event = await db.events.get(eventId);
    const before = await db.invoices.get(invoiceId);
    const r = await upsertInvoiceForBidder(db, event!, bidderId);
    expect(r.kind).toBe("unchanged");
    const after = await db.invoices.get(invoiceId);
    expect(after?.generatedAt.getTime()).toBe(before?.generatedAt.getTime());
  });

  it("attaches a new unallocated sale to the unpaid invoice and updates totals", async () => {
    const lot2 = (await db.lots.add({
      eventId,
      baseLotNumber: 2,
      lotSuffix: "",
      displayLotNumber: "2",
      description: "Lot 2",
      quantity: 1,
      status: "sold",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    await db.sales.add({
      eventId,
      lotId: lot2,
      bidderId,
      displayLotNumber: "2",
      paddleNumber: 4,
      description: "Lot 2",
      quantity: 1,
      amount: 50,
      clerkInitials: "DW",
      createdAt: new Date(),
    });
    const event = await db.events.get(eventId);
    const r = await attachUnallocatedSalesToUnpaidInvoice(db, event!, bidderId);
    expect(r?.kind).toBe("updated");
    const inv = await db.invoices.get(invoiceId);
    expect(inv?.subtotal).toBe(150);
    expect(inv?.total).toBe(181.5);
    const pending = await db.sales
      .where("eventId")
      .equals(eventId)
      .filter((s) => s.bidderId === bidderId && s.invoiceId == null)
      .count();
    expect(pending).toBe(0);
  });

  it("does not create an invoice when the bidder has no unpaid invoice yet", async () => {
    const otherBidder = (await db.bidders.add({
      eventId,
      paddleNumber: 9,
      firstName: "Z",
      lastName: "Z",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    const lot3 = (await db.lots.add({
      eventId,
      baseLotNumber: 3,
      lotSuffix: "",
      displayLotNumber: "3",
      description: "Lot 3",
      quantity: 1,
      status: "sold",
      createdAt: new Date(),
      updatedAt: new Date(),
    })) as number;
    await db.sales.add({
      eventId,
      lotId: lot3,
      bidderId: otherBidder,
      displayLotNumber: "3",
      paddleNumber: 9,
      description: "Lot 3",
      quantity: 1,
      amount: 20,
      clerkInitials: "DW",
      createdAt: new Date(),
    });
    const event = await db.events.get(eventId);
    const r = await attachUnallocatedSalesToUnpaidInvoice(
      db,
      event!,
      otherBidder
    );
    expect(r).toBeNull();
    expect(await db.invoices.where("eventId").equals(eventId).count()).toBe(1);
  });
});
