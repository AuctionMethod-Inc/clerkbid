import { describe, expect, it } from "vitest";
import {
  matchesNameQuery,
  matchesPhoneLast4,
  matchesSingleNameQuery,
  normalizeEmail,
} from "@/lib/directory/match";
import { searchMasterBidders } from "@/lib/directory/search";
import { invoiceRowKey } from "@/components/invoices/ResaleFlag";

describe("directory match", () => {
  it("matches last 4 digits of phone", () => {
    expect(matchesPhoneLast4("(555) 123-4567", "4567")).toBe(true);
    expect(matchesPhoneLast4("5551234567", "1234")).toBe(false);
    expect(matchesPhoneLast4("555", "4567")).toBe(false);
  });

  it("matches first or last name independently", () => {
    expect(matchesNameQuery("Jane", "Doe", "jane")).toBe(true);
    expect(matchesNameQuery("Jane", "Doe", "doe")).toBe(true);
    expect(matchesNameQuery("Jane", "Doe", "smith")).toBe(false);
  });

  it("matches tokens in a single consignor name", () => {
    expect(matchesSingleNameQuery("Acme Farms LLC", "farms")).toBe(true);
    expect(matchesSingleNameQuery("Acme Farms LLC", "zzz")).toBe(false);
  });

  it("normalizes email", () => {
    expect(normalizeEmail("  A@X.COM ")).toBe("a@x.com");
  });
});

describe("searchMasterBidders", () => {
  const rows = [
    {
      syncKey: "a",
      firstName: "Jane",
      lastName: "Doe",
      phone: "555-0100",
      email: "jane@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      syncKey: "b",
      firstName: "Bob",
      lastName: "Smith",
      phone: "555-9999",
      resaleNumber: "RS-1",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  it("finds by last 4 of phone", () => {
    expect(searchMasterBidders(rows, "0100").map((r) => r.syncKey)).toEqual([
      "a",
    ]);
  });

  it("finds by resale number", () => {
    expect(searchMasterBidders(rows, "RS-1")).toHaveLength(1);
  });
});

describe("invoiceRowKey", () => {
  it("prefers syncKey so remounts stay stable after snapshot replace", () => {
    expect(invoiceRowKey({ syncKey: "abc", id: 9, invoiceNumber: "0001" })).toBe(
      "abc"
    );
    expect(invoiceRowKey({ id: 9 })).toBe("id:9");
  });
});
