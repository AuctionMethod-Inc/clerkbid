"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useToast } from "@/components/providers/ToastProvider";
import type { AuctionEvent, MasterConsignor } from "@/lib/db";
import { openConsignorStatementPdf } from "@/lib/services/consignorStatementPdf";
import {
  buildCombinedConsignorStatementPdf,
  listEventsForMasterConsignor,
  loadCombinedStatement,
} from "@/lib/services/combinedConsignorStatement";

/** Pick auctions and print one statement for a Directory consignor. */
export function CombinedStatementModal({
  consignor,
  onClose,
}: {
  consignor: MasterConsignor | null;
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
    if (!db || !consignor) return;
    let cancelled = false;
    listEventsForMasterConsignor(db, consignor.syncKey)
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
  }, [db, consignor, showToast]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function print() {
    if (!db || !consignor || events == null || selected.size === 0) return;
    setBusy(true);
    try {
      const statement = await loadCombinedStatement(db, consignor, Array.from(selected));
      openConsignorStatementPdf(
        buildCombinedConsignorStatementPdf(consignor, statement)
      );
    } catch (e) {
      showToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not build statement.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={consignor != null}
      title={consignor ? `Statement: ${consignor.name}` : "Statement"}
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
          This consignor is not registered in any auction on this device. Add
          them to an auction from its Consignors page first.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            One PDF with every sold lot, commission and net per auction, plus a
            grand total.
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
