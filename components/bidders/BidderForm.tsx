"use client";

import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Bidder, MasterBidder } from "@/lib/db";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getSuggestedPaddleNumber } from "@/lib/hooks/useBidders";
import { mutateWithParentEventTouch } from "@/lib/db/mutateWithParentEventTouch";
import { flushSingleEventToCloudSnapshot } from "@/lib/services/cloudSync";
import { publishDirectoryChanges } from "@/lib/directory/sync";
import { liveQueryGuard } from "@/lib/dexie/liveQueryGuard";
import { DirectoryLookupModal } from "@/components/directory/DirectoryLookupModal";
import { searchMasterBidders } from "@/lib/directory/search";
import { optTrim } from "@/lib/directory/match";
import {
  findEventBidderByMaster,
  upsertMasterBidder,
} from "@/lib/directory/upsert";
import {
  eventRosterNumberTakenByAnother,
  rosterNumberChanged,
} from "@/lib/roster/eventNumberConflict";

const EMPTY_MASTERS: MasterBidder[] = [];

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  eventId: number;
  editing?: Bidder | null;
  onSwitchToExisting?: (bidder: Bidder) => void;
  startWithLookup?: boolean;
};

export function BidderForm({
  open,
  onClose,
  onSaved,
  eventId,
  editing,
  onSwitchToExisting,
  startWithLookup = false,
}: Props) {
  const { db } = useUserDb();
  const { scheduleCloudPush } = useCloudSync();
  const [paddleNumber, setPaddleNumber] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [resaleNumber, setResaleNumber] = useState("");
  const [masterSyncKey, setMasterSyncKey] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [paddleReady, setPaddleReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lookupOpen, setLookupOpen] = useState(false);
  const submittingRef = useRef(false);

  const masters =
    useLiveQuery(
      async () =>
        liveQueryGuard(
          "bidderForm.masters",
          async () => {
            if (!db) return EMPTY_MASTERS;
            return db.masterBidders.toArray();
          },
          EMPTY_MASTERS
        ),
      [db]
    ) ?? EMPTY_MASTERS;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLookupOpen(Boolean(startWithLookup) && !editing);
    setPaddleReady(false);
    (async () => {
      if (!db) {
        setError("Local database is unavailable. Reload and try again.");
        return;
      }
      if (editing) {
        setPaddleNumber(String(editing.paddleNumber));
        setFirstName(editing.firstName);
        setLastName(editing.lastName);
        setPhone(editing.phone ?? "");
        setEmail(editing.email ?? "");
        setMailingAddress(editing.mailingAddress ?? "");
        setResaleNumber(editing.resaleNumber ?? "");
        setMasterSyncKey(editing.masterSyncKey);
        setPaddleReady(true);
      } else {
        const next = await getSuggestedPaddleNumber(db, eventId);
        setPaddleNumber(String(next));
        setFirstName("");
        setLastName("");
        setPhone("");
        setEmail("");
        setMailingAddress("");
        setResaleNumber("");
        setMasterSyncKey(undefined);
        setPaddleReady(true);
      }
    })();
  }, [open, editing, eventId, db, startWithLookup]);

  function currentFields() {
    return {
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: optTrim(phone),
      email: optTrim(email),
      mailingAddress: optTrim(mailingAddress),
      resaleNumber: optTrim(resaleNumber),
    };
  }

  async function applyLookup(master: MasterBidder) {
    if (!db) return;
    const existing = await findEventBidderByMaster(db, eventId, master.syncKey);
    if (existing && (editing?.id == null || existing.id !== editing.id)) {
      onSwitchToExisting?.(existing);
      setLookupOpen(false);
      if (!editing) onClose();
      return;
    }
    setFirstName(master.firstName);
    setLastName(master.lastName);
    setPhone(master.phone ?? "");
    setEmail(master.email ?? "");
    setMailingAddress(master.mailingAddress ?? "");
    setResaleNumber(master.resaleNumber ?? "");
    setMasterSyncKey(master.syncKey);
    setLookupOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!db) {
      setError("Local database is unavailable. Reload and try again.");
      return;
    }
    if (!paddleReady) {
      setError("One moment — still loading. Try again.");
      return;
    }
    setError(null);
    const paddle = parseInt(paddleNumber.trim(), 10);
    if (!Number.isFinite(paddle) || paddle < 1) {
      setError("Paddle number must be a positive integer.");
      return;
    }
    const fields = currentFields();
    if (!fields.firstName || !fields.lastName) {
      setError("First and last name are required.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (rosterNumberChanged(editing?.paddleNumber, paddle)) {
        const eventBidders = await db.bidders
          .where("eventId")
          .equals(eventId)
          .toArray();
        if (
          eventRosterNumberTakenByAnother(
            eventBidders.map((b) => ({ id: b.id, number: b.paddleNumber })),
            paddle,
            editing?.id
          )
        ) {
          setError(`Paddle #${paddle} is already registered for this event.`);
          return;
        }
      }
      const now = new Date();
      const master = await upsertMasterBidder(db, fields, {
        preferredSyncKey: masterSyncKey,
        now,
      });
      const linkKey = master.syncKey;
      setMasterSyncKey(linkKey);
      try {
        await mutateWithParentEventTouch(db, eventId, "bidders", async () => {
          if (editing) {
            let existing =
              editing.id != null
                ? await db.bidders.get(editing.id)
                : undefined;
            if (!existing) {
              existing = await db.bidders
                .where("eventId")
                .equals(eventId)
                .filter((b) => b.paddleNumber === editing.paddleNumber)
                .first();
            }
            if (!existing?.id) {
              throw new Error(
                "Could not find this bidder. Close the form and try again."
              );
            }
            const next: Bidder = {
              ...existing,
              id: existing.id,
              paddleNumber: paddle,
              firstName: fields.firstName,
              lastName: fields.lastName,
              phone: fields.phone,
              email: fields.email,
              mailingAddress: fields.mailingAddress,
              resaleNumber: fields.resaleNumber,
              masterSyncKey: linkKey,
              updatedAt: now,
            };
            if (!next.phone) delete next.phone;
            if (!next.email) delete next.email;
            if (!next.mailingAddress) delete next.mailingAddress;
            if (!next.resaleNumber) delete next.resaleNumber;
            await db.bidders.put(next);
          } else {
            await db.bidders.add({
              eventId,
              paddleNumber: paddle,
              firstName: fields.firstName,
              lastName: fields.lastName,
              phone: fields.phone,
              email: fields.email,
              mailingAddress: fields.mailingAddress,
              resaleNumber: fields.resaleNumber,
              masterSyncKey: linkKey,
              createdAt: now,
              updatedAt: now,
            });
          }
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not save bidder. Try again."
        );
        return;
      }
      if (typeof navigator !== "undefined" && navigator.onLine) {
        try {
          await flushSingleEventToCloudSnapshot(db, eventId);
        } catch {
          /* fall back to debounced push */
        }
        try {
          await publishDirectoryChanges(db);
        } catch {
          /* fall back to background directory sync */
        }
      }
      scheduleCloudPush();
      onSaved();
      onClose();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <Modal
        open={open}
        title={editing ? "Edit bidder" : "Register bidder"}
        onClose={onClose}
        footer={
          <>
            <Button
              variant="secondary"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="bidder-form"
              disabled={submitting || !paddleReady}
            >
              {submitting
                ? "Saving…"
                : editing
                  ? "Save"
                  : "Add bidder"}
            </Button>
          </>
        }
      >
        <form id="bidder-form" className="space-y-4" onSubmit={handleSubmit}>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          {!editing ? (
            <Button
              variant="secondary"
              type="button"
              onClick={() => setLookupOpen(true)}
            >
              Lookup
            </Button>
          ) : null}
          <Input
            id="bd-paddle"
            label="Paddle number"
            inputMode="numeric"
            value={paddleNumber}
            onChange={(e) => setPaddleNumber(e.target.value)}
            required
          />
          <Input
            id="bd-fn"
            label="First name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
          />
          <Input
            id="bd-ln"
            label="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
          />
          <Input
            id="bd-phone"
            label="Phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <Input
            id="bd-email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <div>
            <label
              htmlFor="bd-addr"
              className="mb-1 block text-sm font-medium text-ink dark:text-slate-200"
            >
              Address
            </label>
            <textarea
              id="bd-addr"
              rows={3}
              value={mailingAddress}
              onChange={(e) => setMailingAddress(e.target.value)}
              placeholder="Street, city, state, ZIP"
              className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
          </div>
          <Input
            id="bd-resale"
            label="Resale number"
            value={resaleNumber}
            onChange={(e) => setResaleNumber(e.target.value)}
          />
        </form>
      </Modal>
      <DirectoryLookupModal
        open={lookupOpen}
        title="Lookup bidder"
        description="Search the master list by first or last name, email, or last 4 digits of phone."
        rows={masters}
        onClose={() => setLookupOpen(false)}
        onSelect={(row) => void applyLookup(row)}
        filter={(row, q) => searchMasterBidders([row], q).length > 0}
        renderRow={(row) => ({
          primary: `${row.lastName}, ${row.firstName}`,
          secondary: [row.email, row.phone, row.resaleNumber ? `Resale #${row.resaleNumber}` : ""]
            .filter(Boolean)
            .join(" · "),
        })}
      />
    </>
  );
}
