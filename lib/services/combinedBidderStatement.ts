import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type {
  AuctionDB,
  AuctionEvent,
  Bidder,
  Invoice,
  MasterBidder,
} from "@/lib/db";
import { roundMoney } from "@/lib/services/invoiceLogic";
import { drawPdfAttributionFooter } from "@/lib/services/consignorStatementPdf";
import { PAYMENT_METHODS } from "@/lib/utils/constants";
import { formatCurrency } from "@/lib/utils/formatCurrency";

/** One event's data, as loaded from the local database. */
export type BidderStatementEventInput = {
  event: AuctionEvent;
  bidders: Bidder[];
  invoices: Invoice[];
};

export type BidderStatementLine = {
  invoiceNumber: string;
  paddleNumber: number;
  generatedAt: Date;
  total: number;
  status: Invoice["status"];
  paymentMethod?: Invoice["paymentMethod"];
  paymentDate?: Date;
};

export type BidderStatementSection = {
  event: AuctionEvent;
  /**
   * The event bidders linked to the Directory entry. Usually one; more when
   * a Directory merge pointed several of an event's bidders at it.
   */
  bidders: Bidder[];
  lines: BidderStatementLine[];
  invoiced: number;
  paid: number;
  due: number;
};

export type BidderStatementTotal = {
  currencySymbol: string;
  invoiced: number;
  paid: number;
  due: number;
};

export type BidderStatement = {
  sections: BidderStatementSection[];
  /** One entry per currency symbol, in the order the events use them. */
  totals: BidderStatementTotal[];
};

export function paymentMethodLabel(
  method: Invoice["paymentMethod"]
): string | undefined {
  if (!method) return undefined;
  return PAYMENT_METHODS.find((m) => m.value === method)?.label ?? method;
}

/**
 * Invoices of one Directory bidder across several events, grouped by event,
 * with invoiced, paid and balance due per event and in total. Events where
 * the bidder has no linked event bidder are left out.
 */
export function buildBidderStatement(
  master: MasterBidder,
  inputs: BidderStatementEventInput[]
): BidderStatement {
  const sections: BidderStatementSection[] = [];
  const totals = new Map<string, BidderStatementTotal>();

  for (const { event, bidders, invoices } of inputs) {
    const linked = bidders.filter((b) => b.masterSyncKey === master.syncKey);
    if (linked.length === 0) continue;
    const paddleById = new Map<number, number>();
    for (const b of linked) {
      if (b.id != null) paddleById.set(b.id, b.paddleNumber);
    }
    const lines: BidderStatementLine[] = invoices
      .filter((inv) => paddleById.has(inv.bidderId))
      .sort((a, b) =>
        a.invoiceNumber.localeCompare(b.invoiceNumber, undefined, {
          numeric: true,
        })
      )
      .map((inv) => ({
        invoiceNumber: inv.invoiceNumber,
        paddleNumber: paddleById.get(inv.bidderId)!,
        generatedAt: inv.generatedAt,
        total: inv.total,
        status: inv.status,
        paymentMethod: inv.paymentMethod,
        paymentDate: inv.paymentDate,
      }));
    const invoiced = roundMoney(lines.reduce((t, l) => t + l.total, 0));
    const paid = roundMoney(
      lines.reduce((t, l) => (l.status === "paid" ? t + l.total : t), 0)
    );
    const due = roundMoney(invoiced - paid);
    sections.push({ event, bidders: linked, lines, invoiced, paid, due });

    const sym = event.currencySymbol ?? "$";
    const total = totals.get(sym) ?? {
      currencySymbol: sym,
      invoiced: 0,
      paid: 0,
      due: 0,
    };
    total.invoiced = roundMoney(total.invoiced + invoiced);
    total.paid = roundMoney(total.paid + paid);
    total.due = roundMoney(total.due + due);
    totals.set(sym, total);
  }

  return { sections, totals: Array.from(totals.values()) };
}

/** Events (newest first) where this Directory bidder is registered. */
export async function listEventsForMasterBidder(
  db: AuctionDB,
  masterSyncKey: string
): Promise<AuctionEvent[]> {
  const linked = await db.bidders
    .where("masterSyncKey")
    .equals(masterSyncKey)
    .toArray();
  const ids = Array.from(new Set(linked.map((b) => b.eventId)));
  const events = (await db.events.bulkGet(ids)).filter(
    (e): e is AuctionEvent => e != null
  );
  return events.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function loadBidderStatement(
  db: AuctionDB,
  master: MasterBidder,
  eventIds: number[]
): Promise<BidderStatement> {
  const events = (await db.events.bulkGet(eventIds)).filter(
    (e): e is AuctionEvent => e?.id != null
  );
  events.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const inputs = await Promise.all(
    events.map(async (event) => {
      const [bidders, invoices] = await Promise.all([
        db.bidders
          .where("[eventId+masterSyncKey]")
          .equals([event.id!, master.syncKey])
          .toArray(),
        db.invoices.where("eventId").equals(event.id!).toArray(),
      ]);
      return { event, bidders, invoices };
    })
  );
  return buildBidderStatement(master, inputs);
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? fallback
  );
}

function formatDate(d: Date | string | undefined): string {
  if (d == null) return "";
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}

function statusLabel(line: BidderStatementLine): string {
  if (line.status !== "paid") return "Unpaid";
  const parts = ["Paid", paymentMethodLabel(line.paymentMethod), formatDate(line.paymentDate)];
  return parts.filter(Boolean).join(", ");
}

export function buildBidderStatementPdf(
  master: MasterBidder,
  statement: BidderStatement
): jsPDF {
  const doc = new jsPDF();
  const pageH = doc.internal.pageSize.getHeight();
  const orgName = statement.sections[0]?.event.organizationName;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(30, 58, 95);
  doc.text("Bidder statement (all selected auctions)", 14, 18);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);
  let y = 26;
  if (orgName) {
    doc.text(orgName, 14, y);
    y += 6;
  }
  doc.text(`${master.firstName} ${master.lastName}`.trim(), 14, y);
  y += 6;
  const addr = master.mailingAddress?.trim();
  if (addr) {
    doc.setFontSize(10);
    for (const line of addr.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      doc.text(t.slice(0, 90), 14, y);
      y += 5;
    }
    doc.setFontSize(11);
  }
  y += 4;

  for (const section of statement.sections) {
    const sym = section.event.currencySymbol ?? "$";
    if (y > pageH - 50) {
      doc.addPage();
      y = 18;
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(30, 58, 95);
    doc.text(section.event.name, 14, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(60, 60, 60);
    const paddles = section.bidders.map((b) => `#${b.paddleNumber}`);
    doc.text(
      `Paddle${paddles.length === 1 ? "" : "s"} ${paddles.join(", ")}`,
      14,
      y + 6
    );

    autoTable(doc, {
      startY: y + 9,
      head: [["Invoice", "Paddle", "Date", "Total", "Status"]],
      body:
        section.lines.length > 0
          ? section.lines.map((l) => [
              l.invoiceNumber,
              String(l.paddleNumber),
              formatDate(l.generatedAt),
              formatCurrency(l.total, sym),
              statusLabel(l),
            ])
          : [["", "", "No invoices", "", ""]],
      foot: [
        [
          "Auction total",
          "",
          "",
          formatCurrency(section.invoiced, sym),
          `Paid ${formatCurrency(section.paid, sym)}, due ${formatCurrency(
            section.due,
            sym
          )}`,
        ],
      ],
      showFoot: "lastPage",
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 58, 95] },
      footStyles: { fillColor: [235, 239, 245], textColor: [30, 30, 30] },
      columnStyles: {
        0: { cellWidth: 30 },
        1: { cellWidth: 18 },
        2: { cellWidth: 28 },
        3: { cellWidth: 30 },
        4: { cellWidth: "auto" },
      },
    });
    y = lastTableY(doc, y + 20) + 10;
  }

  if (y > pageH - 20 - statement.totals.length * 21) {
    doc.addPage();
    y = 18;
  }
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(30, 30, 30);
  const auctions = statement.sections.length;
  doc.text(
    `Grand total (${auctions} auction${auctions === 1 ? "" : "s"})`,
    14,
    y
  );
  y += 7;
  for (const t of statement.totals) {
    doc.text(`Total invoiced: ${formatCurrency(t.invoiced, t.currencySymbol)}`, 14, y);
    doc.text(`Total paid: ${formatCurrency(t.paid, t.currencySymbol)}`, 14, y + 7);
    doc.text(`Balance due: ${formatCurrency(t.due, t.currencySymbol)}`, 14, y + 14);
    y += 21;
  }

  for (let p = 1; p <= doc.getNumberOfPages(); p++) {
    doc.setPage(p);
    drawPdfAttributionFooter(doc);
  }
  return doc;
}
