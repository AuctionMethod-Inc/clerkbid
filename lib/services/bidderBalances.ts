import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { AuctionDB, AuctionEvent, Bidder, Invoice, MasterBidder } from "@/lib/db";
import { roundMoney } from "@/lib/services/invoiceLogic";
import { drawPdfAttributionFooter } from "@/lib/services/consignorStatementPdf";
import { formatCurrency } from "@/lib/utils/formatCurrency";

/** One event's data, as loaded from the local database. */
export type BidderBalanceEventInput = {
  event: AuctionEvent;
  bidders: Bidder[];
  invoices: Invoice[];
};

export type BidderBalanceRow = {
  /**
   * `m:<syncKey>|<currency>` for a Directory bidder,
   * `e:<eventId>:<bidderId>|<currency>` otherwise.
   */
  key: string;
  name: string;
  /** False when the event bidder is not linked to a Directory entry. */
  inDirectory: boolean;
  currencySymbol: string;
  /** "Auction name #paddle", one per event bidder that has invoices. */
  paddles: string[];
  invoiceCount: number;
  invoiced: number;
  paid: number;
  due: number;
};

export type BidderBalanceTotal = {
  currencySymbol: string;
  invoiced: number;
  paid: number;
  due: number;
};

export type BidderBalances = {
  rows: BidderBalanceRow[];
  /** One entry per currency symbol, over the rows returned. */
  totals: BidderBalanceTotal[];
};

function fullName(first: string | undefined, last: string | undefined): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

/**
 * Invoiced, paid and balance due per bidder across the given events. A
 * bidder linked to the Directory gets one row across all events (per
 * currency); a bidder not linked gets a row of their own for that event.
 * Bidders with no invoices are left out. Sorted by name.
 */
export function buildBidderBalances(
  inputs: BidderBalanceEventInput[],
  masters: MasterBidder[],
  opts: { unpaidOnly?: boolean } = {}
): BidderBalances {
  const masterByKey = new Map(masters.map((m) => [m.syncKey, m]));
  const rows = new Map<string, BidderBalanceRow>();

  for (const { event, bidders, invoices } of inputs) {
    const sym = event.currencySymbol ?? "$";
    const bidderById = new Map<number, Bidder>();
    for (const b of bidders) {
      if (b.id != null) bidderById.set(b.id, b);
    }
    const counted = new Set<number>();
    for (const inv of invoices) {
      const b = bidderById.get(inv.bidderId);
      if (!b) continue;
      const master = b.masterSyncKey ? masterByKey.get(b.masterSyncKey) : undefined;
      const key = master
        ? `m:${master.syncKey}|${sym}`
        : `e:${event.id}:${b.id}|${sym}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          name: master
            ? fullName(master.firstName, master.lastName)
            : fullName(b.firstName, b.lastName),
          inDirectory: master != null,
          currencySymbol: sym,
          paddles: [],
          invoiceCount: 0,
          invoiced: 0,
          paid: 0,
          due: 0,
        };
        rows.set(key, row);
      }
      if (!counted.has(b.id!)) {
        counted.add(b.id!);
        row.paddles.push(`${event.name} #${b.paddleNumber}`);
      }
      row.invoiceCount += 1;
      row.invoiced = roundMoney(row.invoiced + inv.total);
      if (inv.status === "paid") row.paid = roundMoney(row.paid + inv.total);
      row.due = roundMoney(row.invoiced - row.paid);
    }
  }

  const list = Array.from(rows.values())
    .filter((r) => !opts.unpaidOnly || r.due !== 0)
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
        a.key.localeCompare(b.key)
    );

  const totals = new Map<string, BidderBalanceTotal>();
  for (const r of list) {
    const t = totals.get(r.currencySymbol) ?? {
      currencySymbol: r.currencySymbol,
      invoiced: 0,
      paid: 0,
      due: 0,
    };
    t.invoiced = roundMoney(t.invoiced + r.invoiced);
    t.paid = roundMoney(t.paid + r.paid);
    t.due = roundMoney(t.due + r.due);
    totals.set(r.currencySymbol, t);
  }

  return { rows: list, totals: Array.from(totals.values()) };
}

/** Every event on this device, newest first. */
export async function listEventsForBalances(db: AuctionDB): Promise<AuctionEvent[]> {
  const events = await db.events.toArray();
  return events.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function loadBidderBalances(
  db: AuctionDB,
  eventIds: number[],
  opts: { unpaidOnly?: boolean } = {}
): Promise<BidderBalances> {
  const events = (await db.events.bulkGet(eventIds)).filter(
    (e): e is AuctionEvent => e?.id != null
  );
  const [inputs, masters] = await Promise.all([
    Promise.all(
      events.map(async (event) => {
        const [bidders, invoices] = await Promise.all([
          db.bidders.where("eventId").equals(event.id!).toArray(),
          db.invoices.where("eventId").equals(event.id!).toArray(),
        ]);
        return { event, bidders, invoices };
      })
    ),
    db.masterBidders.toArray(),
  ]);
  return buildBidderBalances(inputs, masters, opts);
}

export const BIDDER_BALANCE_CSV_HEADERS = [
  "Bidder",
  "In Directory",
  "Auctions and paddles",
  "Invoices",
  "Currency",
  "Invoiced",
  "Paid",
  "Balance due",
];

export function bidderBalanceCsvRows(b: BidderBalances): (string | number)[][] {
  return b.rows.map((r) => [
    r.name,
    r.inDirectory ? "yes" : "no",
    r.paddles.join("; "),
    r.invoiceCount,
    r.currencySymbol,
    r.invoiced.toFixed(2),
    r.paid.toFixed(2),
    r.due.toFixed(2),
  ]);
}

export function buildBidderBalancesPdf(
  balances: BidderBalances,
  opts: { organizationName?: string; auctionNames: string[]; unpaidOnly?: boolean }
): jsPDF {
  const doc = new jsPDF();
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(30, 58, 95);
  doc.text(
    opts.unpaidOnly ? "Bidder balances (unpaid only)" : "Bidder balances",
    14,
    18
  );
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);
  let y = 26;
  if (opts.organizationName) {
    doc.text(opts.organizationName, 14, y);
    y += 6;
  }
  const auctions = doc.splitTextToSize(
    `Auctions: ${opts.auctionNames.join(", ")}`,
    182
  ) as string[];
  doc.text(auctions, 14, y);
  y += auctions.length * 5 + 2;

  autoTable(doc, {
    startY: y,
    head: [["Bidder", "Auctions and paddles", "Invoiced", "Paid", "Balance due"]],
    body:
      balances.rows.length > 0
        ? balances.rows.map((r) => [
            r.inDirectory ? r.name : `${r.name} *`,
            r.paddles.join("\n"),
            formatCurrency(r.invoiced, r.currencySymbol),
            formatCurrency(r.paid, r.currencySymbol),
            formatCurrency(r.due, r.currencySymbol),
          ])
        : [["No invoices", "", "", "", ""]],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [30, 58, 95] },
    columnStyles: {
      0: { cellWidth: 40 },
      1: { cellWidth: "auto" },
      2: { cellWidth: 26, halign: "right" },
      3: { cellWidth: 26, halign: "right" },
      4: { cellWidth: 26, halign: "right" },
    },
  });
  y =
    ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? y + 20) + 8;

  if (y > pageH - 30 - balances.totals.length * 21) {
    doc.addPage();
    y = 18;
  }
  doc.setFont("helvetica", "bold");
  doc.setTextColor(30, 30, 30);
  for (const t of balances.totals) {
    doc.text(`Total invoiced: ${formatCurrency(t.invoiced, t.currencySymbol)}`, 14, y);
    doc.text(`Total paid: ${formatCurrency(t.paid, t.currencySymbol)}`, 14, y + 7);
    doc.text(`Balance due: ${formatCurrency(t.due, t.currencySymbol)}`, 14, y + 14);
    y += 21;
  }
  if (balances.rows.some((r) => !r.inDirectory)) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.text(
      "* Not linked to the Directory: shown once per auction.",
      14,
      y
    );
  }

  for (let p = 1; p <= doc.getNumberOfPages(); p++) {
    doc.setPage(p);
    drawPdfAttributionFooter(doc);
  }
  return doc;
}
