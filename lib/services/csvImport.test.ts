import { describe, expect, it } from "vitest";
import { normalizeHeaderKey } from "./csvParse";
import { parseBidderCsv } from "./csvImportBidders";
import { parseConsignorCsv } from "./csvImportConsignors";
import { parseLotCsv } from "./csvImportLots";

describe("parseBidderCsv", () => {
  it("parses standard headers", () => {
    const csv = `paddleNumber,firstName,lastName,email,phone
101,Jane,Doe,j@x.com,555`;
    const { rows, issues } = parseBidderCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows).toEqual([
      {
        paddleNumber: 101,
        firstName: "Jane",
        lastName: "Doe",
        email: "j@x.com",
        phone: "555",
      },
    ]);
  });

  it("parses optional address and resale number", () => {
    const csv = `paddle,first,last,address,resale
101,Jane,Doe,"123 Main St",RS-9`;
    const { rows, issues } = parseBidderCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.mailingAddress).toBe("123 Main St");
    expect(rows[0]?.resaleNumber).toBe("RS-9");
  });

  it("detects duplicate paddles in file", () => {
    const csv = `paddle,first,last
1,A,B
1,C,D`;
    const { rows, issues } = parseBidderCsv(csv);
    expect(rows).toHaveLength(1);
    expect(issues.some((i) => i.message.includes("Duplicate"))).toBe(true);
  });
});

describe("normalizeHeaderKey", () => {
  it("strips punctuation so LOT # maps like lot", () => {
    expect(normalizeHeaderKey("LOT #")).toBe("lot");
    expect(normalizeHeaderKey("Lot #")).toBe("lot");
  });
});

describe("parseLotCsv", () => {
  it("builds display lot from base and suffix", () => {
    const csv = `baseLotNumber,suffix,description,quantity
12,A,Widget,1`;
    const { rows, issues } = parseLotCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.displayLotNumber).toBe("12A");
  });

  it("parses optional consignorNumber", () => {
    const csv = `base,suffix,description,consignorNumber,quantity
5,,Chair,42,1`;
    const { rows, issues } = parseLotCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.consignorNumber).toBe(42);
  });

  it("accepts plain Lot, Description, Quantity headers", () => {
    const csv = `Lot,Description,Quantity
1,Fire Ring & 2 chairs,1
1S,IU Champagne Bottle,1`;
    const { rows, issues } = parseLotCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.displayLotNumber).toBe("1");
    expect(rows[0]?.baseLotNumber).toBe(1);
    expect(rows[0]?.lotSuffix).toBe("");
    expect(rows[1]?.displayLotNumber).toBe("1S");
    expect(rows[1]?.baseLotNumber).toBe(1);
    expect(rows[1]?.lotSuffix).toBe("S");
  });

  it("splits combined lot cell like 4S into base and suffix for clerking lookup", () => {
    const csv = `Lot,Description
4S,Corner Café Gift Certificate`;
    const { rows, issues } = parseLotCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.displayLotNumber).toBe("4S");
    expect(rows[0]?.baseLotNumber).toBe(4);
    expect(rows[0]?.lotSuffix).toBe("S");
  });

  it("accepts Lot number and LOT # style headers", () => {
    const csv1 = `Lot number,Description
10,Ten`;
    expect(parseLotCsv(csv1).issues).toHaveLength(0);
    expect(parseLotCsv(csv1).rows[0]?.displayLotNumber).toBe("10");

    const csv2 = `LOT #,desc
7,Seven`;
    const { rows, issues } = parseLotCsv(csv2);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.displayLotNumber).toBe("7");
    expect(rows[0]?.description).toBe("Seven");
  });

  it("accepts qty alias for quantity", () => {
    const csv = `lot,description,qty
3,Thing,2`;
    const { rows, issues } = parseLotCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.quantity).toBe(2);
  });
});

describe("parseConsignorCsv", () => {
  it("parses commission percent", () => {
    const csv = `consignorNumber,name,commission
7,Jane Doe,12.5`;
    const { rows, issues } = parseConsignorCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.commissionPct).toBe(12.5);
  });

  it("parses mailing address column", () => {
    const csv = `consignorNumber,name,mailingAddress
8,Bob,PO Box 1`;
    const { rows, issues } = parseConsignorCsv(csv);
    expect(issues).toHaveLength(0);
    expect(rows[0]?.mailingAddress).toBe("PO Box 1");
  });
});
