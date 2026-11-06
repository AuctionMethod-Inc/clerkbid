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

/** One bidder's invoices in one auction. */
export type BidderBalanceEventLine = {
  eventId: number;
  eventName: string;
  /** "#12", or "(bidder deleted)" when the bidder row is gone. */
  paddle: string;
  invoiceCount: number;
  invoiced: number;
  paid: number;
  due: number;
};

/** Every bidder's invoices in one auction, over the rows returned. */
export type BidderBalanceEventTotal = {
  eventId: number;
  eventName: string;
  currencySymbol: string;
  invoiced: number;
  paid: number;
  due: number;
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
  /** Per-auction breakdown, in the order the auctions were given. */
  events: BidderBalanceEventLine[];
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
  /** One entry per auction with invoices in the rows returned. */
  byEvent: BidderBalanceEventTotal[];
};

/** Name shown for invoices whose bidder row no longer exists. */
export const UNKNOWN_BIDDER = "Unknown bidder";

function fullName(first: string | undefined, last: string | undefined): string {
  return `${first ?? ""} ${last ?? ""}`.trim();
}

/**
 * Invoiced, paid and balance due per bidder across the given events. A
 * bidder linked to the Directory gets one row across all events (per
 * currency); a bidder not linked gets a row of their own for that event.
 * Bidders with no invoices are left out. Invoices whose bidder was deleted
 * get an "Unknown bidder" row for that event. Sorted by name.
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
      // An invoice whose bidder row was deleted still counts, so the totals
      // match the event's own reports. It gets an "Unknown bidder" row.
      const master =
        b?.masterSyncKey ? masterByKey.get(b.masterSyncKey) : undefined;
      const key = master
        ? `m:${master.syncKey}|${sym}`
        : `e:${event.id}:${inv.bidderId}|${sym}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          name: master
            ? fullName(master.firstName, master.lastName)
            : b
              ? fullName(b.firstName, b.lastName)
              : UNKNOWN_BIDDER,
          inDirectory: master != null,
          currencySymbol: sym,
          paddles: [],
          events: [],
          invoiceCount: 0,
          invoiced: 0,
          paid: 0,
          due: 0,
        };
        rows.set(key, row);
      }
      const paddle = b ? `#${b.paddleNumber}` : "(bidder deleted)";
      if (!counted.has(inv.bidderId)) {
        counted.add(inv.bidderId);
        row.paddles.push(`${event.name} ${paddle}`);
      }
      // A Directory bidder with two paddles in one auction gets one line
      // for that auction, listing both paddles.
      let line = row.events.find((l) => l.eventId === event.id);
      if (!line) {
        line = {
          eventId: event.id!,
          eventName: event.name,
          paddle,
          invoiceCount: 0,
          invoiced: 0,
          paid: 0,
          due: 0,
        };
        row.events.push(line);
      } else if (!line.paddle.split(", ").includes(paddle)) {
        line.paddle = `${line.paddle}, ${paddle}`;
      }
      line.invoiceCount += 1;
      line.invoiced = roundMoney(line.invoiced + inv.total);
      if (inv.status === "paid") line.paid = roundMoney(line.paid + inv.total);
      line.due = roundMoney(line.invoiced - line.paid);
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

  const byEvent = new Map<string, BidderBalanceEventTotal>();
  for (const r of list) {
    for (const l of r.events) {
      const k = `${l.eventId}|${r.currencySymbol}`;
      const t = byEvent.get(k) ?? {
        eventId: l.eventId,
        eventName: l.eventName,
        currencySymbol: r.currencySymbol,
        invoiced: 0,
        paid: 0,
        due: 0,
      };
      t.invoiced = roundMoney(t.invoiced + l.invoiced);
      t.paid = roundMoney(t.paid + l.paid);
      t.due = roundMoney(t.due + l.due);
      byEvent.set(k, t);
    }
  }
  const eventOrder = new Map(inputs.map((i, n) => [i.event.id, n]));
  const byEventList = Array.from(byEvent.values()).sort(
    (a, b) => (eventOrder.get(a.eventId) ?? 0) - (eventOrder.get(b.eventId) ?? 0)
  );

  return {
    rows: list,
    totals: Array.from(totals.values()),
    byEvent: byEventList,
  };
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
  "Auction",
  "Paddle",
  "Invoices",
  "Currency",
  "Invoiced",
  "Paid",
  "Balance due",
];

export function bidderBalanceCsvRows(b: BidderBalances): (string | number)[][] {
  // One line per bidder per auction, so the sheet can be summed or
  // filtered by auction.
  return b.rows.flatMap((r) =>
    r.events.map((l) => [
      r.name,
      r.inDirectory ? "yes" : "no",
      l.eventName,
      l.paddle,
      l.invoiceCount,
      r.currencySymbol,
      l.invoiced.toFixed(2),
      l.paid.toFixed(2),
      l.due.toFixed(2),
    ])
  );
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

  // One line per bidder per auction, with Paid and Unpaid in their own
  // columns; a bold total line under any bidder in more than one auction.
  type Cell = string | { content: string; styles: Record<string, unknown> };
  const bold = (c: string): Cell => ({ content: c, styles: { fontStyle: "bold" } });
  const body: Cell[][] = [];
  for (const r of balances.rows) {
    const name = r.inDirectory ? r.name : `${r.name} *`;
    r.events.forEach((l, i) => {
      body.push([
        i === 0 ? name : "",
        l.eventName,
        l.paddle,
        formatCurrency(l.invoiced, r.currencySymbol),
        formatCurrency(l.paid, r.currencySymbol),
        formatCurrency(l.due, r.currencySymbol),
      ]);
    });
    if (r.events.length > 1) {
      body.push([
        "",
        bold(`Total, ${r.events.length} auctions`),
        "",
        bold(formatCurrency(r.invoiced, r.currencySymbol)),
        bold(formatCurrency(r.paid, r.currencySymbol)),
        bold(formatCurrency(r.due, r.currencySymbol)),
      ]);
    }
  }
  const money = { cellWidth: 24, halign: "right" as const };
  // Right-align the money headers over their right-aligned figures.
  const alignMoneyHeads =
    (firstMoneyCol: number) =>
    (data: { section: string; column: { index: number }; cell: { styles: { halign: string } } }) => {
      if (data.section === "head" && data.column.index >= firstMoneyCol) {
        data.cell.styles.halign = "right";
      }
    };
  autoTable(doc, {
    startY: y,
    head: [["Bidder", "Auction", "Paddle", "Invoiced", "Paid", "Unpaid"]],
    body: body.length > 0 ? body : [["No invoices", "", "", "", "", ""]],
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [30, 58, 95] },
    columnStyles: {
      0: { cellWidth: 36 },
      1: { cellWidth: "auto" },
      2: { cellWidth: 16 },
      3: money,
      4: money,
      5: money,
    },
    didParseCell: alignMoneyHeads(3),
  });
  y =
    ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? y + 20) + 8;

  if (balances.byEvent.length > 0) {
    if (y > pageH - 40) {
      doc.addPage();
      y = 18;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(30, 58, 95);
    doc.text("Totals by auction", 14, y);
    autoTable(doc, {
      startY: y + 3,
      head: [["Auction", "Invoiced", "Paid", "Unpaid"]],
      body: balances.byEvent.map((t) => [
        t.eventName,
        formatCurrency(t.invoiced, t.currencySymbol),
        formatCurrency(t.paid, t.currencySymbol),
        formatCurrency(t.due, t.currencySymbol),
      ]),
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 58, 95] },
      columnStyles: { 0: { cellWidth: "auto" }, 1: money, 2: money, 3: money },
      didParseCell: alignMoneyHeads(1),
    });
    y =
      ((doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
        ?.finalY ?? y + 20) + 8;
    doc.setFontSize(10);
  }

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
