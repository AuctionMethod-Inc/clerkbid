import { describe, expect, it } from "vitest";
import { invoiceBillToLines } from "@/lib/services/invoicePdf";

describe("invoiceBillToLines", () => {
  it("includes address and resale on the paddle line", () => {
    expect(
      invoiceBillToLines({
        bidderName: "Jane Doe",
        paddleNumber: 12,
        phone: "555-0100",
        email: "j@x.com",
        mailingAddress: "123 Main St\nSpringfield ST 62701",
        resaleNumber: "RS-9",
      })
    ).toEqual([
      "Jane Doe",
      "Paddle #12  Resale #RS-9",
      "555-0100  j@x.com",
      "123 Main St",
      "Springfield ST 62701",
    ]);
  });

  it("omits empty optional lines", () => {
    expect(
      invoiceBillToLines({
        bidderName: "Pat Lee",
        paddleNumber: 1,
      })
    ).toEqual(["Pat Lee", "Paddle #1"]);
  });
});
