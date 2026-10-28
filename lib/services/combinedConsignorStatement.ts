import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type {
  AuctionDB,
  AuctionEvent,
  Consignor,
  Lot,
  MasterConsignor,
  Sale,
} from "@/lib/db";
import { roundMoney } from "@/lib/services/invoiceLogic";
import { resolveConsignorForSale } from "@/lib/services/consignorAttribution";
import {
  effectiveCommissionRate,
  lineCommission,
} from "@/lib/services/consignorCommission";
import {
  drawPdfAttributionFooter,
  listSalesForConsignorStatement,
} from "@/lib/services/consignorStatementPdf";
import { formatCurrency } from "@/lib/utils/formatCurrency";

/** One event's data, as loaded from the local database. */
export type CombinedStatementEventInput = {
  event: AuctionEvent;
  /** Every consignor in the event (needed to resolve sale attribution). */
  consignors: Consignor[];
  lots: Lot[];
  sales: Sale[];
};

export type CombinedStatementLine = {
  lot: string;
  description: string;
  quantity: number;
  hammer: number;
  rate: number;
  commission: number;
  net: number;
};

export type CombinedStatementSection = {
  event: AuctionEvent;
  /** The event consignor linked to the Directory entry. */
  consignor: Consignor;
  lines: CombinedStatementLine[];
  hammer: number;
  commission: number;
  net: number;
};

export type CombinedStatementTotal = {
  currencySymbol: string;
  hammer: number;
  commission: number;
  net: number;
};

export type CombinedStatement = {
  sections: CombinedStatementSection[];
  /** One entry per currency symbol, in the order the events use them. */
  totals: CombinedStatementTotal[];
};

function rateLabel(rate: number): string {
  return `${(rate * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

/**
 * Sold lots of one Directory consignor across several events, grouped by
 * event, with commission and net per event and a grand total. Events where
 * the consignor has no linked event consignor are left out.
 */
export function buildCombinedStatement(
  master: MasterConsignor,
  inputs: CombinedStatementEventInput[]
): CombinedStatement {
  const sections: CombinedStatementSection[] = [];
  const totals = new Map<string, CombinedStatementTotal>();

  for (const { event, consignors, lots, sales } of inputs) {
    const consignor = consignors.find((c) => c.masterSyncKey === master.syncKey);
    if (!consignor) continue;
    const lotById = new Map<number, Lot>();
    for (const l of lots) {
      if (l.id != null) lotById.set(l.id, l);
    }
    const lines = listSalesForConsignorStatement(consignor, consignors, lots, sales)
      .sort((a, b) =>
        a.displayLotNumber.localeCompare(b.displayLotNumber, undefined, {
          numeric: true,
        })
      )
      .map((s) => {
        const rate = effectiveCommissionRate(
          event,
          resolveConsignorForSale(s, lotById.get(s.lotId), consignors)
        );
        const commission = lineCommission(s.amount, rate);
        return {
          lot: s.displayLotNumber,
          description: s.description,
          quantity: s.quantity,
          hammer: s.amount,
          rate,
          commission,
          net: roundMoney(s.amount - commission),
        };
      });
    const hammer = roundMoney(lines.reduce((t, l) => t + l.hammer, 0));
    const commission = roundMoney(lines.reduce((t, l) => t + l.commission, 0));
    const net = roundMoney(hammer - commission);
    sections.push({ event, consignor, lines, hammer, commission, net });

    const sym = event.currencySymbol ?? "$";
    const total = totals.get(sym) ?? {
      currencySymbol: sym,
      hammer: 0,
      commission: 0,
      net: 0,
    };
    total.hammer = roundMoney(total.hammer + hammer);
    total.commission = roundMoney(total.commission + commission);
    total.net = roundMoney(total.net + net);
    totals.set(sym, total);
  }

  return { sections, totals: Array.from(totals.values()) };
}

/** Events (newest first) where this Directory consignor is registered. */
export async function listEventsForMasterConsignor(
  db: AuctionDB,
  masterSyncKey: string
): Promise<AuctionEvent[]> {
  const linked = await db.consignors
    .where("masterSyncKey")
    .equals(masterSyncKey)
    .toArray();
  const ids = Array.from(new Set(linked.map((c) => c.eventId)));
  const events = (await db.events.bulkGet(ids)).filter(
    (e): e is AuctionEvent => e != null
  );
  return events.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export async function loadCombinedStatement(
  db: AuctionDB,
  master: MasterConsignor,
  eventIds: number[]
): Promise<CombinedStatement> {
  const events = (await db.events.bulkGet(eventIds)).filter(
    (e): e is AuctionEvent => e?.id != null
  );
  events.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  const inputs = await Promise.all(
    events.map(async (event) => {
      const [consignors, lots, sales] = await Promise.all([
        db.consignors.where("eventId").equals(event.id!).toArray(),
        db.lots.where("eventId").equals(event.id!).toArray(),
        db.sales.where("eventId").equals(event.id!).toArray(),
      ]);
      return { event, consignors, lots, sales };
    })
  );
  return buildCombinedStatement(master, inputs);
}

function lastTableY(doc: jsPDF, fallback: number): number {
  return (
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? fallback
  );
}

export function buildCombinedConsignorStatementPdf(
  master: MasterConsignor,
  statement: CombinedStatement
): jsPDF {
  const doc = new jsPDF();
  const pageH = doc.internal.pageSize.getHeight();
  const orgName = statement.sections[0]?.event.organizationName;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(30, 58, 95);
  doc.text("Consignor statement (all selected auctions)", 14, 18);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);
  let y = 26;
  if (orgName) {
    doc.text(orgName, 14, y);
    y += 6;
  }
  doc.text(master.name, 14, y);
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
    doc.text(`Consignor #${section.consignor.consignorNumber}`, 14, y + 6);

    autoTable(doc, {
      startY: y + 9,
      head: [["Lot", "Description", "Qty", "Hammer", "Rate", "Commission", "Net"]],
      body:
        section.lines.length > 0
          ? section.lines.map((l) => [
              l.lot,
              l.description.slice(0, 80),
              String(l.quantity),
              formatCurrency(l.hammer, sym),
              rateLabel(l.rate),
              formatCurrency(l.commission, sym),
              formatCurrency(l.net, sym),
            ])
          : [["", "No sold lots", "", "", "", "", ""]],
      foot: [
        [
          "",
          "Auction total",
          "",
          formatCurrency(section.hammer, sym),
          "",
          formatCurrency(section.commission, sym),
          formatCurrency(section.net, sym),
        ],
      ],
      showFoot: "lastPage",
      styles: { fontSize: 8, cellPadding: 2 },
      headStyles: { fillColor: [30, 58, 95] },
      footStyles: { fillColor: [235, 239, 245], textColor: [30, 30, 30] },
      columnStyles: {
        0: { cellWidth: 22 },
        1: { cellWidth: 52 },
        2: { cellWidth: 12 },
        3: { cellWidth: 22 },
        4: { cellWidth: 16 },
        5: { cellWidth: 24 },
        6: { cellWidth: 22 },
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
    doc.text(`Total hammer: ${formatCurrency(t.hammer, t.currencySymbol)}`, 14, y);
    doc.text(
      `Total commission: ${formatCurrency(t.commission, t.currencySymbol)}`,
      14,
      y + 7
    );
    doc.text(`Net to consignor: ${formatCurrency(t.net, t.currencySymbol)}`, 14, y + 14);
    y += 21;
  }

  for (let p = 1; p <= doc.getNumberOfPages(); p++) {
    doc.setPage(p);
    drawPdfAttributionFooter(doc);
  }
  return doc;
}
