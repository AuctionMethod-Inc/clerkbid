"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useToast } from "@/components/providers/ToastProvider";
import type { AuctionEvent } from "@/lib/db";
import { downloadCsv } from "@/lib/services/csvExporter";
import { openConsignorStatementPdf } from "@/lib/services/consignorStatementPdf";
import {
  BIDDER_BALANCE_CSV_HEADERS,
  bidderBalanceCsvRows,
  buildBidderBalancesPdf,
  listEventsForBalances,
  loadBidderBalances,
  type BidderBalances,
} from "@/lib/services/bidderBalances";
import { formatCurrency } from "@/lib/utils/formatCurrency";

/** Invoiced, paid and balance due for every bidder across picked auctions. */
export function BidderBalancesModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { db } = useUserDb();
  const { showToast } = useToast();
  const [events, setEvents] = useState<AuctionEvent[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const [balances, setBalances] = useState<BidderBalances | null>(null);

  useEffect(() => {
    setEvents(null);
    setSelected(new Set());
    setBalances(null);
    if (!db || !open) return;
    let cancelled = false;
    listEventsForBalances(db)
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows);
        setSelected(new Set(rows.map((e) => e.id!)));
      })
      .catch(() => {
        if (cancelled) return;
        setEvents([]);
        showToast({ kind: "error", message: "Could not load auctions." });
      });
    return () => {
      cancelled = true;
    };
  }, [db, open, showToast]);

  useEffect(() => {
    // Drop the previous result so Print/CSV stay disabled until the rows
    // match the current auctions and filter.
    setBalances(null);
    if (!db || !open || events == null) return;
    let cancelled = false;
    loadBidderBalances(db, Array.from(selected), { unpaidOnly })
      .then((b) => {
        if (!cancelled) setBalances(b);
      })
      .catch(() => {
        if (!cancelled) {
          setBalances(null);
          showToast({ kind: "error", message: "Could not load balances." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [db, open, events, selected, unpaidOnly, showToast]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const picked = (events ?? []).filter((e) => selected.has(e.id!));
  const canExport = balances != null && picked.length > 0;

  function print() {
    if (!balances) return;
    openConsignorStatementPdf(
      buildBidderBalancesPdf(balances, {
        organizationName: picked[0]?.organizationName,
        auctionNames: picked.map((e) => e.name),
        unpaidOnly,
      })
    );
  }

  function exportCsv() {
    if (!balances) return;
    downloadCsv(
      unpaidOnly ? "clerkbid-bidder-balances-unpaid.csv" : "clerkbid-bidder-balances.csv",
      BIDDER_BALANCE_CSV_HEADERS,
      bidderBalanceCsvRows(balances)
    );
  }

  return (
    <Modal
      open={open}
      title="Bidder balances"
      onClose={onClose}
      maxWidthClass="max-w-4xl"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="secondary"
            type="button"
            disabled={!canExport}
            onClick={exportCsv}
          >
            Export CSV
          </Button>
          <Button type="button" disabled={!canExport} onClick={print}>
            Print
          </Button>
        </>
      }
    >
      {events == null ? (
        <p className="text-sm text-muted">Loading auctions…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted">There are no auctions on this device.</p>
      ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm text-muted">
              Every bidder with an invoice in the ticked auctions. Bidders
              picked from the Directory are added up across auctions; others
              are listed once per auction.
            </p>
            <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {events.map((e) => (
                <label key={e.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(e.id!)}
                    onChange={() => toggle(e.id!)}
                  />
                  {e.name}
                </label>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={unpaidOnly}
                onChange={(e) => setUnpaidOnly(e.target.checked)}
              />
              Unpaid only
            </label>
          </div>

          {balances == null ? (
            <p className="text-sm text-muted">Loading balances…</p>
          ) : balances.rows.length === 0 ? (
            <p className="text-sm text-muted">
              {unpaidOnly ? "No unpaid invoices." : "No invoices."}
            </p>
          ) : (
            <div className="max-h-80 overflow-auto rounded-lg border border-navy/10 dark:border-slate-700">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-surface dark:bg-slate-800">
                  <tr>
                    <th className="px-2 py-1 text-left">Bidder</th>
                    <th className="px-2 py-1 text-left">Auction</th>
                    <th className="px-2 py-1 text-left">Paddle</th>
                    <th className="px-2 py-1 text-right">Invoiced</th>
                    <th className="px-2 py-1 text-right">Paid</th>
                    <th className="px-2 py-1 text-right">Unpaid</th>
                  </tr>
                </thead>
                {balances.rows.map((r) => (
                  <tbody
                    key={r.key}
                    className="border-t border-navy/10 dark:border-slate-700"
                  >
                    {r.events.map((l, i) => (
                      <tr key={l.eventId}>
                        <td className="px-2 py-1 align-top">
                          {i === 0 ? (
                            <>
                              {r.name}
                              {r.inDirectory ? null : (
                                <span className="ml-1 text-xs text-muted">
                                  (not in Directory)
                                </span>
                              )}
                            </>
                          ) : null}
                        </td>
                        <td className="px-2 py-1 text-muted">{l.eventName}</td>
                        <td className="px-2 py-1 text-muted">{l.paddle}</td>
                        <td className="px-2 py-1 text-right font-mono">
                          {formatCurrency(l.invoiced, r.currencySymbol)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {formatCurrency(l.paid, r.currencySymbol)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {formatCurrency(l.due, r.currencySymbol)}
                        </td>
                      </tr>
                    ))}
                    {r.events.length > 1 ? (
                      <tr className="font-semibold">
                        <td className="px-2 py-1" />
                        <td className="px-2 py-1" colSpan={2}>
                          Total, {r.events.length} auctions
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {formatCurrency(r.invoiced, r.currencySymbol)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {formatCurrency(r.paid, r.currencySymbol)}
                        </td>
                        <td className="px-2 py-1 text-right font-mono">
                          {formatCurrency(r.due, r.currencySymbol)}
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                ))}
                <tfoot className="border-t-2 border-navy/20 dark:border-slate-600">
                  {balances.byEvent.map((t) => (
                    <tr key={`${t.eventId}|${t.currencySymbol}`} className="text-muted">
                      <td className="px-2 py-1" colSpan={3}>
                        {t.eventName}, all bidders
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {formatCurrency(t.invoiced, t.currencySymbol)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {formatCurrency(t.paid, t.currencySymbol)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {formatCurrency(t.due, t.currencySymbol)}
                      </td>
                    </tr>
                  ))}
                  {balances.totals.map((t) => (
                    <tr key={t.currencySymbol} className="font-semibold">
                      <td className="px-2 py-1" colSpan={3}>
                        Total
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {formatCurrency(t.invoiced, t.currencySymbol)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {formatCurrency(t.paid, t.currencySymbol)}
                      </td>
                      <td className="px-2 py-1 text-right font-mono">
                        {formatCurrency(t.due, t.currencySymbol)}
                      </td>
                    </tr>
                  ))}
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
