"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { liveQueryGuard } from "@/lib/dexie/liveQueryGuard";
import {
  copyBiddersFromEvent,
  type CopyBiddersResult,
  type CopyPaddleMode,
} from "@/lib/directory/copyBidders";

export function CopyBiddersDialog({
  open,
  eventId,
  onClose,
  onCopied,
  onError,
}: {
  open: boolean;
  eventId: number;
  onClose: () => void;
  onCopied: (result: CopyBiddersResult) => void;
  onError: (message: string) => void;
}) {
  const { db } = useUserDb();
  const [fromEventId, setFromEventId] = useState("");
  const [paddles, setPaddles] = useState<CopyPaddleMode>("keep");
  const [busy, setBusy] = useState(false);

  const sources = useLiveQuery(
    async () =>
      liveQueryGuard("bidders.copySources", async () => {
        if (!db || !open) return [];
        const events = await db.events.orderBy("createdAt").reverse().toArray();
        const out: Array<{ id: number; name: string; count: number }> = [];
        for (const ev of events) {
          if (ev.id == null || ev.id === eventId) continue;
          const count = await db.bidders.where("eventId").equals(ev.id).count();
          if (count > 0) out.push({ id: ev.id, name: ev.name, count });
        }
        return out;
      }, []),
    [db, open, eventId]
  );

  useEffect(() => {
    if (!open) return;
    setPaddles("keep");
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open || !sources) return;
    if (!sources.some((s) => String(s.id) === fromEventId)) {
      setFromEventId(sources[0] ? String(sources[0].id) : "");
    }
  }, [open, sources, fromEventId]);

  const copy = async () => {
    if (!db || !fromEventId || busy) return;
    setBusy(true);
    try {
      const result = await copyBiddersFromEvent(db, {
        fromEventId: Number(fromEventId),
        toEventId: eventId,
        paddles,
      });
      onCopied(result);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Copy failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Add bidders from a previous auction"
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void copy()}
            disabled={busy || !fromEventId}
          >
            {busy ? "Copying…" : "Copy bidders"}
          </Button>
        </>
      }
    >
      {!sources ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : sources.length === 0 ? (
        <p className="text-sm text-muted">
          No other auction has registered bidders yet.
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <label
              htmlFor="copy-bidders-from"
              className="mb-1 block text-sm font-medium text-ink dark:text-slate-200"
            >
              Copy from
            </label>
            <select
              id="copy-bidders-from"
              className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
              value={fromEventId}
              disabled={busy}
              onChange={(e) => setFromEventId(e.target.value)}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.count} bidder{s.count === 1 ? "" : "s"})
                </option>
              ))}
            </select>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink dark:text-slate-200">
              Paddle numbers
            </legend>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-ink dark:text-slate-200">
              <input
                type="radio"
                name="copy-bidders-paddles"
                className="mt-1"
                checked={paddles === "keep"}
                disabled={busy}
                onChange={() => setPaddles("keep")}
              />
              <span>
                <span className="font-medium">Keep their paddle numbers</span>
                <span className="mt-0.5 block text-xs text-muted">
                  If a paddle is already taken in this auction, that bidder gets
                  the next free number. You&apos;ll see who was renumbered.
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm text-ink dark:text-slate-200">
              <input
                type="radio"
                name="copy-bidders-paddles"
                className="mt-1"
                checked={paddles === "renumber"}
                disabled={busy}
                onChange={() => setPaddles("renumber")}
              />
              <span>
                <span className="font-medium">Number them fresh</span>
                <span className="mt-0.5 block text-xs text-muted">
                  Start from the next free paddle in this auction.
                </span>
              </span>
            </label>
          </fieldset>
          <p className="text-xs text-muted">
            Bidders already registered in this auction are skipped.
          </p>
        </div>
      )}
    </Modal>
  );
}
