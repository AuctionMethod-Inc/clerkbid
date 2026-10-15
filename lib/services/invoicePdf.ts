import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { formatCurrency } from "@/lib/utils/formatCurrency";
import { formatDateOnly } from "@/lib/utils/formatDate";
import { PAYMENT_METHODS } from "@/lib/utils/constants";
import {
  AUCTION_METHOD_BRAND,
  AUCTION_METHOD_URL,
} from "@/lib/utils/attribution";

export type InvoicePdfLine = {
  displayLotNumber: string;
  description: string;
  quantity: number;
  unitHammer: number;
  lineHammer: number;
};

export type InvoicePdfInput = {
  organizationName: string;
  eventName: string;
  invoiceNumber: string;
  generatedAt: Date;
  taxRate: number;
  /** Event buyer's premium rate (for label); line amount is in buyersPremiumAmount. */
  buyersPremiumRate: number;
  currencySymbol: string;
  bidderName: string;
  paddleNumber: number;
  phone?: string;
  email?: string;
  mailingAddress?: string;
  resaleNumber?: string;
  status: "unpaid" | "paid";
  paymentMethod?: string;
  paymentDate?: Date;
  lines: InvoicePdfLine[];
  hammerSubtotal: number;
  buyersPremiumAmount: number;
  taxAmount: number;
  total: number;
  /** Closing line on PDF (after payment block). */
  invoiceFooterLine: string;
  invoiceLogoDataUrl?: string;
  invoiceLogoWidthMm?: number;
  invoiceLogoHeightMm?: number;
};

function paymentLabel(value: string | undefined): string {
  if (!value) return "—";
  return PAYMENT_METHODS.find((p) => p.value === value)?.label ?? value;
}

/** Bill To lines for invoice PDFs (name, paddle/resale, contact, address). */
export function invoiceBillToLines(
  input: Pick<
    InvoicePdfInput,
    | "bidderName"
    | "paddleNumber"
    | "phone"
    | "email"
    | "mailingAddress"
    | "resaleNumber"
  >
): string[] {
  const lines: string[] = [input.bidderName];
  const resale = input.resaleNumber?.trim();
  lines.push(
    resale
      ? `Paddle #${input.paddleNumber}  Resale #${resale}`
      : `Paddle #${input.paddleNumber}`
  );
  const contact = [input.phone, input.email].filter(Boolean).join("  ");
  if (contact) lines.push(contact);
  const addr = input.mailingAddress?.trim();
  if (addr) {
    for (const part of addr.split(/\r?\n/)) {
      const t = part.trim();
      if (t) lines.push(t);
    }
  }
  return lines;
}

/** Centered footer on the current (last) page with clickable brand link. */
function drawPdfAttributionFooter(doc: jsPDF): void {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const footerY = pageH - 8;

  const prefix = "Powered by ";
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 110);

  const wPrefix = doc.getTextWidth(prefix);
  const wBrand = doc.getTextWidth(AUCTION_METHOD_BRAND);
  const startX = (pageW - (wPrefix + wBrand)) / 2;

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

/** Draw one invoice on the current page of `doc` (caller sets page). */
export function renderInvoiceOnDoc(doc: jsPDF, input: InvoicePdfInput): void {
  const sym = input.currencySymbol;
  let y = 14;

  if (
    input.invoiceLogoDataUrl &&
    input.invoiceLogoWidthMm != null &&
    input.invoiceLogoHeightMm != null
  ) {
    try {
      doc.addImage(
        input.invoiceLogoDataUrl,
        "PNG",
        14,
        y,
        input.invoiceLogoWidthMm,
        input.invoiceLogoHeightMm
      );
    } catch {
      /* ignore broken image */
    }
    y += input.invoiceLogoHeightMm + 5;
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(30, 58, 95);
  doc.text(input.organizationName, 14, y);
  y += 8;
  doc.setFontSize(14);
  doc.text("INVOICE", 14, y);
  y += 10;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(0, 0, 0);
  doc.text(`Invoice #: ${input.invoiceNumber}`, 14, y);
  y += 5;
  doc.text(`Date: ${formatDateOnly(input.generatedAt)}`, 14, y);
  y += 5;
  doc.text(`Event: ${input.eventName}`, 14, y);
  y += 10;

  doc.setFont("helvetica", "bold");
  doc.text("Bill To:", 14, y);
  doc.setFont("helvetica", "normal");
  y += 5;
  for (const line of invoiceBillToLines(input)) {
    const wrapped = doc.splitTextToSize(line, 120) as string[];
    for (const w of wrapped) {
      doc.text(w, 14, y);
      y += 5;
    }
  }
  y += 4;

  const body = input.lines.map((r) => [
    r.displayLotNumber,
    r.description,
    String(r.quantity),
    formatCurrency(r.unitHammer, sym),
    formatCurrency(r.lineHammer, sym),
  ]);

  autoTable(doc, {
    startY: y,
    head: [["Lot #", "Description", "Qty", "Unit", "Line total"]],
    body,
    theme: "striped",
    headStyles: { fillColor: [30, 58, 95] },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 9 },
    columnStyles: {
      0: { cellWidth: 22 },
      2: { cellWidth: 14, halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
    },
  });

  const finalY =
    (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
      ?.finalY ?? y + 40;
  let ty = finalY + 10;
  const taxPct =
    input.taxRate === 0 ? "0%" : `${(input.taxRate * 100).toFixed(2)}%`;
  const bpPct =
    input.buyersPremiumRate === 0
      ? "0%"
      : `${(input.buyersPremiumRate * 100).toFixed(2)}%`;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text(
    `Hammer subtotal: ${formatCurrency(input.hammerSubtotal, sym)}`,
    doc.internal.pageSize.getWidth() - 14,
    ty,
    { align: "right" }
  );
  ty += 5;
  if (input.buyersPremiumAmount !== 0 || input.buyersPremiumRate > 0) {
    doc.text(
      `Buyer's premium (${bpPct}): ${formatCurrency(input.buyersPremiumAmount, sym)}`,
      doc.internal.pageSize.getWidth() - 14,
      ty,
      { align: "right" }
    );
    ty += 5;
  }
  if (input.taxAmount !== 0 || input.taxRate > 0) {
    doc.text(
      `Tax (${taxPct}): ${formatCurrency(input.taxAmount, sym)}`,
      doc.internal.pageSize.getWidth() - 14,
      ty,
      { align: "right" }
    );
    ty += 5;
  }
  doc.setFont("helvetica", "bold");
  doc.text(
    `TOTAL: ${formatCurrency(input.total, sym)}`,
    doc.internal.pageSize.getWidth() - 14,
    ty,
    { align: "right" }
  );
  ty += 12;
  doc.setFont("helvetica", "normal");
  doc.text(
    `Payment status: ${input.status === "paid" ? "PAID" : "UNPAID"}`,
    14,
    ty
  );
  ty += 5;
  if (input.status === "paid") {
    doc.text(`Payment method: ${paymentLabel(input.paymentMethod)}`, 14, ty);
    ty += 5;
    if (input.paymentDate) {
      doc.text(`Payment date: ${formatDateOnly(input.paymentDate)}`, 14, ty);
      ty += 5;
    }
  }
  ty += 4;
  doc.setTextColor(80, 80, 80);
  doc.setFontSize(9);
  const footerLines = doc.splitTextToSize(input.invoiceFooterLine, 180);
  let fy = ty;
  for (const line of footerLines) {
    doc.text(line, 14, fy);
    fy += 4.5;
  }
  doc.setTextColor(0, 0, 0);

  const lastPage = doc.getNumberOfPages();
  doc.setPage(lastPage);
  drawPdfAttributionFooter(doc);
}

export function buildInvoicePdf(input: InvoicePdfInput): jsPDF {
  const doc = new jsPDF();
  renderInvoiceOnDoc(doc, input);
  return doc;
}

export function buildCombinedInvoicePdf(inputs: InvoicePdfInput[]): jsPDF {
  const doc = new jsPDF();
  inputs.forEach((input, i) => {
    if (i > 0) doc.addPage();
    doc.setPage(doc.getNumberOfPages());
    renderInvoiceOnDoc(doc, input);
  });
  return doc;
}

export function openPdfInNewTab(doc: jsPDF, filename: string) {
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const w = window.open(url, "_blank", "noopener,noreferrer");
  if (w) {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else {
    doc.save(filename);
    URL.revokeObjectURL(url);
  }
}
