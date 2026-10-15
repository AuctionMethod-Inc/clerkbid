"use client";

import { Flag } from "lucide-react";

export function ResaleFlag({
  resaleNumber,
  className = "",
}: {
  resaleNumber?: string;
  className?: string;
}) {
  const n = resaleNumber?.trim();
  if (!n) return null;
  return (
    <span
      className={`inline-flex items-center text-gold ${className}`}
      title={`Resale #${n}`}
    >
      <Flag
        className="h-4 w-4 fill-gold text-gold"
        aria-hidden
        strokeWidth={2}
      />
      <span className="sr-only">{`Resale #${n}`}</span>
    </span>
  );
}

export function invoiceRowKey(inv: {
  syncKey?: string;
  id?: number;
  invoiceNumber?: string;
}): string {
  if (inv.syncKey) return inv.syncKey;
  if (inv.id != null) return `id:${inv.id}`;
  return `num:${inv.invoiceNumber ?? ""}`;
}
