"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useToast } from "@/components/providers/ToastProvider";
import type { AuctionEvent, MasterBidder } from "@/lib/db";
import { openConsignorStatementPdf } from "@/lib/services/consignorStatementPdf";
import {
  buildBidderStatementPdf,
  listEventsForMasterBidder,
  loadBidderStatement,
} from "@/lib/services/combinedBidderStatement";

/** Pick auctions and print one invoice statement for a Directory bidder. */
export function BidderStatementModal({
  bidder,
  onClose,
}: {
  bidder: MasterBidder | null;
  onClose: () => void;
}) {
  const { db } = useUserDb();
  const { showToast } = useToast();
  const [events, setEvents] = useState<AuctionEvent[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setEvents(null);
    setSelected(new Set());
    if (!db || !bidder) return;
    let cancelled = false;
    listEventsForMasterBidder(db, bidder.syncKey)
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
  }, [db, bidder, showToast]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function print() {
    if (!db || !bidder || events == null || selected.size === 0) return;
    setBusy(true);
    try {
      const statement = await loadBidderStatement(db, bidder, Array.from(selected));
      openConsignorStatementPdf(buildBidderStatementPdf(bidder, statement));
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not build statement.",
      });
    } finally {
      setBusy(false);
    }
  }

  const name = bidder ? `${bidder.firstName} ${bidder.lastName}`.trim() : "";

  return (
    <Modal
      open={bidder != null}
      title={bidder ? `Statement: ${name}` : "Statement"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={busy || events == null || selected.size === 0}
            onClick={() => void print()}
          >
            {busy ? "Building…" : "Print statement"}
          </Button>
        </>
      }
    >
      {events == null ? (
        <p className="text-sm text-muted">Loading auctions…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted">
          This bidder is not registered in any auction on this device. Add
          them to an auction from its Bidders page first.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            One PDF with every invoice, paid or unpaid, per auction, plus total
            paid and balance due.
          </p>
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
      )}
    </Modal>
  );
}
