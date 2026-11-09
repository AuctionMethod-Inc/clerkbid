import { describe, expect, it } from "vitest";
import { isSuperAdminUserIdAndEmail } from "./superAdmin";

describe("isSuperAdminUserIdAndEmail", () => {
  it("accepts user id 1", () => {
    expect(isSuperAdminUserIdAndEmail("1", "someone@example.com")).toBe(true);
  });

  it("accepts Daniel and Killian by email, case-insensitively", () => {
    expect(isSuperAdminUserIdAndEmail(5, "daniel@auctionmethod.com")).toBe(true);
    expect(isSuperAdminUserIdAndEmail(7, " Killian@AuctionMethod.com ")).toBe(true);
  });

  it("rejects everyone else", () => {
    expect(isSuperAdminUserIdAndEmail(9, "clerk@auctionmethod.com")).toBe(false);
    expect(isSuperAdminUserIdAndEmail(9, null)).toBe(false);
    expect(isSuperAdminUserIdAndEmail(undefined, undefined)).toBe(false);
  });
});
