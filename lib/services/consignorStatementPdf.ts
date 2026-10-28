import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { AuctionEvent, Consignor, Lot, Sale } from "@/lib/db";
import { resolveConsignorForSale } from "@/lib/services/consignorAttribution";
import {
  effectiveCommissionRate,
  lineCommission,
} from "@/lib/services/consignorCommission";
import { formatCurrency } from "@/lib/utils/formatCurrency";
import {
  AUCTION_METHOD_BRAND,
  AUCTION_METHOD_URL,
} from "@/lib/utils/attribution";

export function drawPdfAttributionFooter(doc: jsPDF): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const footerY = pageH - 8;
  const prefix = "Powered by ";
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 110);
  const wPrefix = doc.getTextWidth(prefix);
  const startX = (pageW - (wPrefix + doc.getTextWidth(AUCTION_METHOD_BRAND))) / 2;
  doc.text(prefix, startX, footerY);
  const docWithLink = doc as jsPDF & {
    textWithLink: (
      text: string,
      x: number,
      y: number,
      opts: { url: string }
    ) => number;
  };
  docWithLink.textWithLink(AUCTION_METHOD_BRAND, startX + wPrefix, footerY, {
    url: AUCTION_METHOD_URL,
  });
  doc.setTextColor(0, 0, 0);
}

export function listSalesForConsignorStatement(
  consignor: Consignor,
  allConsignors: Consignor[],
  lots: Lot[],
  sales: Sale[]
): Sale[] {
  const lotById = new Map<number, Lot>();
  for (const l of lots) {
    if (l.id != null) lotById.set(l.id, l);
  }
  return sales.filter((s) => {
    const lot = lotById.get(s.lotId);
    const r = resolveConsignorForSale(s, lot, allConsignors);
    return r?.id === consignor.id;
  });
}

export function buildConsignorStatementPdf(
  event: AuctionEvent,
  consignor: Consignor,
  lots: Lot[],
  sales: Sale[],
  allConsignors: Consignor[]
): jsPDF {
  const sym = event.currencySymbol ?? "$";
  const lotById = new Map<number, Lot>();
  for (const l of lots) {
    if (l.id != null) lotById.set(l.id, l);
  }

  const lines = listSalesForConsignorStatement(
    consignor,
    allConsignors,
    lots,
    sales
  ).sort((a, b) =>
    a.displayLotNumber.localeCompare(b.displayLotNumber, undefined, {
      numeric: true,
    })
  );

  const rate = effectiveCommissionRate(event, consignor);
  const rateLabel =
    rate === 0 ? "0%" : `${(rate * 100).toFixed(2).replace(/\.?0+$/, "")}%`;

  const doc = new jsPDF();
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(30, 58, 95);
  doc.text("Consignor statement", 14, 18);
  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(60, 60, 60);
  doc.text(event.organizationName, 14, 26);
  doc.text(event.name, 14, 32);
  let headerY = 40;
  doc.text(
    `Consignor #${consignor.consignorNumber} — ${consignor.name}`,
    14,
    headerY
  );
  headerY += 6;
  const addr = consignor.mailingAddress?.trim();
  if (addr) {
    doc.setFontSize(10);
    for (const line of addr.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      doc.text(t.slice(0, 90), 14, headerY);
      headerY += 5;
    }
    doc.setFontSize(11);
  }
  doc.text(`Commission rate (this statement): ${rateLabel}`, 14, headerY);
  headerY += 8;

  let gross = 0;
  let commission = 0;
  const body = lines.map((s) => {
    const r = effectiveCommissionRate(
      event,
      resolveConsignorForSale(s, lotById.get(s.lotId), allConsignors)
    );
    const comm = lineCommission(s.amount, r);
    const net = Math.round((s.amount - comm) * 100) / 100;
    gross += s.amount;
    commission += comm;
    return [
      s.displayLotNumber,
      s.description.slice(0, 80),
      String(s.quantity),
      formatCurrency(s.amount, sym),
      `${(r * 100).toFixed(2).replace(/\.?0+$/, "")}%`,
      formatCurrency(comm, sym),
      formatCurrency(net, sym),
    ];
  });

  gross = Math.round(gross * 100) / 100;
  commission = Math.round(commission * 100) / 100;
  const netTotal = Math.round((gross - commission) * 100) / 100;

  autoTable(doc, {
    startY: headerY,
    head: [
      [
        "Lot",
        "Description",
        "Qty",
        "Hammer",
        "Rate",
        "Commission",
        "Net",
      ],
    ],
    body,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [30, 58, 95] },
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

  const lastY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? 52;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(30, 30, 30);
  doc.text(`Total hammer: ${formatCurrency(gross, sym)}`, 14, lastY + 10);
  doc.text(`Total commission: ${formatCurrency(commission, sym)}`, 14, lastY + 17);
  doc.text(`Net to consignor: ${formatCurrency(netTotal, sym)}`, 14, lastY + 24);

  doc.setPage(doc.getNumberOfPages());
  drawPdfAttributionFooter(doc);
  return doc;
}

export function openConsignorStatementPdf(doc: jsPDF): void {
  const url = doc.output("bloburl");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}
