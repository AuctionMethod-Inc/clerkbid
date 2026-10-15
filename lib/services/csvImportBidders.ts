import { normalizeHeaderKey, parseCsvTable } from "@/lib/services/csvParse";

export type BidderCsvRow = {
  paddleNumber: number;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  mailingAddress?: string;
  resaleNumber?: string;
};

export type BidderCsvImportIssue = { rowIndex: number; message: string };

const ALIASES: Record<string, keyof BidderCsvRow> = {
  paddlenumber: "paddleNumber",
  paddle: "paddleNumber",
  paddle_no: "paddleNumber",
  firstname: "firstName",
  first_name: "firstName",
  first: "firstName",
  lastname: "lastName",
  last_name: "lastName",
  last: "lastName",
  email: "email",
  phone: "phone",
  mailingaddress: "mailingAddress",
  mailing_address: "mailingAddress",
  address: "mailingAddress",
  mailing: "mailingAddress",
  resalenumber: "resaleNumber",
  resale_number: "resaleNumber",
  resale: "resaleNumber",
};

function colIndex(
  headers: string[],
  key: keyof BidderCsvRow
): number {
  const norm = headers.map(normalizeHeaderKey);
  for (let i = 0; i < norm.length; i++) {
    const k = ALIASES[norm[i]!];
    if (k === key) return i;
  }
  return -1;
}

export function parseBidderCsv(text: string): {
  rows: BidderCsvRow[];
  issues: BidderCsvImportIssue[];
} {
  const { headers, rows: rawRows } = parseCsvTable(text);
  const issues: BidderCsvImportIssue[] = [];
  if (headers.length === 0) {
    issues.push({ rowIndex: 0, message: "No header row found." });
    return { rows: [], issues };
  }

  const iPaddle = colIndex(headers, "paddleNumber");
  const iFirst = colIndex(headers, "firstName");
  const iLast = colIndex(headers, "lastName");
  const iEmail = colIndex(headers, "email");
  const iPhone = colIndex(headers, "phone");
  const iAddr = colIndex(headers, "mailingAddress");
  const iResale = colIndex(headers, "resaleNumber");

  if (iPaddle < 0 || iFirst < 0 || iLast < 0) {
    issues.push({
      rowIndex: 0,
      message:
        "CSV must include columns: paddleNumber (or paddle), firstName, lastName. Optional: email, phone, mailingAddress, resaleNumber.",
    });
    return { rows: [], issues };
  }

  const rows: BidderCsvRow[] = [];
  const paddlesSeen = new Set<number>();

  for (let r = 0; r < rawRows.length; r++) {
    const line = rawRows[r]!;
    const rowNum = r + 2;
    const paddleStr = (line[iPaddle] ?? "").trim();
    const first = (line[iFirst] ?? "").trim();
    const last = (line[iLast] ?? "").trim();
    const email = iEmail >= 0 ? (line[iEmail] ?? "").trim() : "";
    const phone = iPhone >= 0 ? (line[iPhone] ?? "").trim() : "";
    const mailingAddress = iAddr >= 0 ? (line[iAddr] ?? "").trim() : "";
    const resaleNumber = iResale >= 0 ? (line[iResale] ?? "").trim() : "";

    if (!paddleStr && !first && !last) continue;

    const paddleNumber = parseInt(paddleStr, 10);
    if (!Number.isFinite(paddleNumber) || paddleNumber < 1) {
      issues.push({
        rowIndex: rowNum,
        message: `Invalid paddle number: "${paddleStr}".`,
      });
      continue;
    }
    if (!first || !last) {
      issues.push({
        rowIndex: rowNum,
        message: "firstName and lastName are required.",
      });
      continue;
    }
    if (paddlesSeen.has(paddleNumber)) {
      issues.push({
        rowIndex: rowNum,
        message: `Duplicate paddle ${paddleNumber} in file.`,
      });
      continue;
    }
    paddlesSeen.add(paddleNumber);

    rows.push({
      paddleNumber,
      firstName: first,
      lastName: last,
      email: email || undefined,
      phone: phone || undefined,
      mailingAddress: mailingAddress || undefined,
      resaleNumber: resaleNumber || undefined,
    });
  }

  return { rows, issues };
}
