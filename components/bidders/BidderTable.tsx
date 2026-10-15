"use client";

import { useMemo, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { BidderRow } from "@/lib/hooks/useBidders";
import { formatCurrency } from "@/lib/utils/formatCurrency";
import { Button } from "@/components/ui/Button";
import { ResaleFlag } from "@/components/invoices/ResaleFlag";

type SortKey =
  | "paddleNumber"
  | "name"
  | "phone"
  | "email"
  | "totalSpent"
  | "itemsWon";

function bidderName(b: BidderRow) {
  return `${b.lastName}, ${b.firstName}`;
}

export function BidderTable({
  rows,
  currencySymbol,
  onEdit,
  onDelete,
}: {
  rows: BidderRow[];
  currencySymbol: string;
  onEdit: (b: BidderRow) => void;
  onDelete: (b: BidderRow) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("paddleNumber");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "paddleNumber":
          cmp = a.paddleNumber - b.paddleNumber;
          break;
        case "name":
          cmp = bidderName(a).localeCompare(bidderName(b));
          break;
        case "phone":
          cmp = (a.phone ?? "").localeCompare(b.phone ?? "");
          break;
        case "email":
          cmp = (a.email ?? "").localeCompare(b.email ?? "");
          break;
        case "totalSpent":
          cmp = a.totalSpent - b.totalSpent;
          break;
        case "itemsWon":
          cmp = a.itemsWon - b.itemsWon;
          break;
        default:
          break;
      }
      return cmp * dir;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const th = (key: SortKey, label: string) => (
    <th scope="col" className="px-3 py-2 text-left">
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="font-semibold text-navy hover:underline dark:text-slate-200"
      >
        {label}
        {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  return (
    <div className="overflow-x-auto rounded-xl border border-navy/10 bg-white dark:border-slate-700 dark:bg-slate-900">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="border-b border-navy/10 bg-surface dark:border-slate-700 dark:bg-slate-800/80">
          <tr>
            {th("paddleNumber", "Paddle #")}
            {th("name", "Name")}
            {th("phone", "Phone")}
            {th("email", "Email")}
            {th("totalSpent", "Total spent")}
            {th("itemsWon", "Items won")}
            <th scope="col" className="px-3 py-2 text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-navy/10 dark:divide-slate-700">
          {sorted.length === 0 ? (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-muted">
                No bidders match your search.
              </td>
            </tr>
          ) : (
            sorted.map((b) => (
              <tr
                key={b.id}
                className="hover:bg-surface/50 dark:hover:bg-slate-800/50"
              >
                <td className="px-3 py-2 font-mono font-medium">
                  <span className="inline-flex items-center gap-1.5">
                    <ResaleFlag resaleNumber={b.resaleNumber} />
                    {b.paddleNumber}
                  </span>
                </td>
                <td className="px-3 py-2 text-ink dark:text-slate-100">
                  {bidderName(b)}
                </td>
                <td className="px-3 py-2 font-mono text-muted">
                  {b.phone ?? "—"}
                </td>
                <td className="px-3 py-2 text-muted">{b.email ?? "—"}</td>
                <td className="px-3 py-2 font-mono">
                  {formatCurrency(b.totalSpent, currencySymbol)}
                </td>
                <td className="px-3 py-2 font-mono">{b.itemsWon}</td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="ghost"
                    type="button"
                    className="!p-1.5"
                    aria-label={`Edit bidder ${bidderName(b)}`}
                    onClick={() => onEdit(b)}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    type="button"
                    className="!p-1.5 text-danger hover:text-red-800"
                    aria-label={`Delete bidder ${bidderName(b)}`}
                    onClick={() => onDelete(b)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
