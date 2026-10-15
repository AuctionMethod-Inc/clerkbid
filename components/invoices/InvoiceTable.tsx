"use client";

import { FileText, CreditCard } from "lucide-react";
import type { Bidder, Invoice } from "@/lib/db";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { formatCurrency } from "@/lib/utils/formatCurrency";
import { formatDateOnly } from "@/lib/utils/formatDate";
import { PAYMENT_METHODS } from "@/lib/utils/constants";
import { invoiceRowKey, ResaleFlag } from "@/components/invoices/ResaleFlag";

export type InvoiceWithBidder = Invoice & { bidder?: Bidder };

function paymentLabel(value: string | undefined): string {
  if (!value) return "—";
  return PAYMENT_METHODS.find((p) => p.value === value)?.label ?? value;
}

export function InvoiceTable({
  rows,
  currencySymbol,
  onRowClick,
  onPrint,
  onMarkPaid,
}: {
  rows: InvoiceWithBidder[];
  currencySymbol: string;
  onRowClick: (inv: InvoiceWithBidder) => void;
  onPrint: (inv: InvoiceWithBidder) => void;
  onMarkPaid: (inv: InvoiceWithBidder) => void;
}) {
  const sym = currencySymbol;

  return (
    <div
      className="w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain rounded-xl border border-navy/10 bg-white [-webkit-overflow-scrolling:touch] dark:border-slate-700 dark:bg-slate-900 max-sm:-mx-4 max-sm:px-4 sm:mx-0 sm:px-0"
      role="region"
      aria-label="Invoice list"
    >
      <table className="w-full min-w-[720px] text-sm sm:min-w-[880px] md:min-w-[980px]">
        <thead className="border-b border-navy/10 bg-surface dark:border-slate-700 dark:bg-slate-800/80">
          <tr>
            <th className="px-3 py-2 text-left font-semibold text-navy dark:text-slate-200">
              Invoice #
            </th>
            <th className="px-3 py-2 text-left font-semibold text-navy dark:text-slate-200">
              Bidder
            </th>
            <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
              Hammer
            </th>
            <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
              Buyer prem.
            </th>
            <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
              Tax
            </th>
            <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
              Total
            </th>
            <th className="px-3 py-2 text-left font-semibold text-navy dark:text-slate-200">
              Status
            </th>
            <th className="px-3 py-2 text-left font-semibold text-navy dark:text-slate-200">
              Payment
            </th>
            <th className="px-3 py-2 text-right font-semibold text-navy dark:text-slate-200">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy/10 dark:divide-slate-700">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-muted">
                No invoices match this filter.
              </td>
            </tr>
          ) : (
            rows.map((inv) => (
              <tr
                key={invoiceRowKey(inv)}
                className="cursor-pointer hover:bg-surface/60 dark:hover:bg-slate-800/60"
                onClick={() => onRowClick(inv)}
              >
                <td className="px-3 py-2 font-mono font-medium text-navy dark:text-slate-200">
                  {inv.invoiceNumber}
                </td>
                <td className="px-3 py-2">
                  {inv.bidder ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-ink dark:text-slate-100">
                        {inv.bidder.firstName} {inv.bidder.lastName}
                      </span>
                      <ResaleFlag resaleNumber={inv.bidder.resaleNumber} />
                      <span className="font-mono text-xs text-muted">
                        #{inv.bidder.paddleNumber}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatCurrency(inv.subtotal, sym)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatCurrency(inv.buyersPremiumAmount, sym)}
                </td>
                <td className="px-3 py-2 text-right font-mono">
                  {formatCurrency(inv.taxAmount, sym)}
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-gold">
                  {formatCurrency(inv.total, sym)}
                </td>
                <td className="px-3 py-2">
                  <Badge tone={inv.status === "paid" ? "success" : "warning"}>
                    {inv.status}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-muted">
                  {inv.status === "paid" ? (
                    <span className="text-xs">
                      {paymentLabel(inv.paymentMethod)}
                      {inv.paymentDate
                        ? ` · ${formatDateOnly(inv.paymentDate)}`
                        : ""}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    type="button"
                    className="!p-1.5"
                    aria-label="Print invoice"
                    onClick={(e) => {
                      e.stopPropagation();
                      onPrint(inv);
                    }}
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                  {inv.status === "unpaid" ? (
                    <Button
                      variant="ghost"
                      type="button"
                      className="!p-1.5"
                      aria-label="Mark paid"
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkPaid(inv);
                      }}
                    >
                      <CreditCard className="h-4 w-4" />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
