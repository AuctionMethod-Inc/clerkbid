"use client";

import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { Consignor, MasterConsignor } from "@/lib/db";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { useCloudSync } from "@/components/providers/CloudSyncProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { getSuggestedConsignorNumber } from "@/lib/hooks/useConsignors";
import { mutateWithParentEventTouch } from "@/lib/db/mutateWithParentEventTouch";
import { liveQueryGuard } from "@/lib/dexie/liveQueryGuard";
import { DirectoryLookupModal } from "@/components/directory/DirectoryLookupModal";
import { searchMasterConsignors } from "@/lib/directory/search";
import { optTrim } from "@/lib/directory/match";
import {
  findEventConsignorByMaster,
  upsertMasterConsignor,
} from "@/lib/directory/upsert";
import { publishDirectoryChanges } from "@/lib/directory/sync";
import {
  eventRosterNumberTakenByAnother,
  rosterNumberChanged,
} from "@/lib/roster/eventNumberConflict";

const EMPTY_MASTERS: MasterConsignor[] = [];

type Props = {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  eventId: number;
  editing?: Consignor | null;
  onSwitchToExisting?: (consignor: Consignor) => void;
  startWithLookup?: boolean;
};

export function ConsignorForm({
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
  const [consignorNumber, setConsignorNumber] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [commissionPct, setCommissionPct] = useState("");
  const [masterSyncKey, setMasterSyncKey] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [lookupOpen, setLookupOpen] = useState(false);

  const masters =
    useLiveQuery(
      async () =>
        liveQueryGuard(
          "consignorForm.masters",
          async () => {
            if (!db) return EMPTY_MASTERS;
            return db.masterConsignors.toArray();
          },
          EMPTY_MASTERS
        ),
      [db]
    ) ?? EMPTY_MASTERS;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLookupOpen(Boolean(startWithLookup) && !editing);
    (async () => {
      if (!db) return;
      if (editing) {
        setConsignorNumber(String(editing.consignorNumber));
        setName(editing.name);
        setPhone(editing.phone ?? "");
        setEmail(editing.email ?? "");
        setMailingAddress(editing.mailingAddress ?? "");
        setNotes(editing.notes ?? "");
        setCommissionPct(
          typeof editing.commissionRate === "number"
            ? String((editing.commissionRate * 100).toFixed(2).replace(/\.?0+$/, ""))
            : ""
        );
        setMasterSyncKey(editing.masterSyncKey);
      } else {
        const next = await getSuggestedConsignorNumber(db, eventId);
        setConsignorNumber(String(next));
        setName("");
        setPhone("");
        setEmail("");
        setMailingAddress("");
        setNotes("");
        setCommissionPct("");
        setMasterSyncKey(undefined);
      }
    })();
  }, [open, editing, eventId, db, startWithLookup]);

  function parsedCommission(): { ok: true; value?: number } | { ok: false; message: string } {
    const cp = commissionPct.trim();
    if (!cp) return { ok: true, value: undefined };
    const pct = Number(cp);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      return {
        ok: false,
        message:
          "Commission override must be between 0 and 100% (or leave blank for event default).",
      };
    }
    return { ok: true, value: pct / 100 };
  }

  function currentFields() {
    const commission = parsedCommission();
    return {
      name: name.trim(),
      phone: optTrim(phone),
      email: optTrim(email),
      mailingAddress: optTrim(mailingAddress),
      notes: optTrim(notes),
      commissionRate: commission.ok ? commission.value : undefined,
    };
  }

  async function applyLookup(master: MasterConsignor) {
    if (!db) return;
    const existing = await findEventConsignorByMaster(db, eventId, master.syncKey);
    if (existing && (editing?.id == null || existing.id !== editing.id)) {
      onSwitchToExisting?.(existing);
      setLookupOpen(false);
      if (!editing) onClose();
      return;
    }
    setName(master.name);
    setPhone(master.phone ?? "");
    setEmail(master.email ?? "");
    setMailingAddress(master.mailingAddress ?? "");
    setNotes(master.notes ?? "");
    setCommissionPct(
      typeof master.commissionRate === "number"
        ? String((master.commissionRate * 100).toFixed(2).replace(/\.?0+$/, ""))
        : ""
    );
    setMasterSyncKey(master.syncKey);
    setLookupOpen(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!db) return;
    setError(null);
    const num = parseInt(consignorNumber.trim(), 10);
    if (!Number.isFinite(num) || num < 1) {
      setError("Consignor number must be a positive integer.");
      return;
    }
    const nm = name.trim();
    if (!nm) {
      setError("Name is required.");
      return;
    }
    const takenCheckNeeded = rosterNumberChanged(
      editing?.consignorNumber,
      num
    );
    if (takenCheckNeeded) {
      const eventConsignors = await db.consignors
        .where("eventId")
        .equals(eventId)
        .toArray();
      if (
        eventRosterNumberTakenByAnother(
          eventConsignors.map((c) => ({
            id: c.id,
            number: c.consignorNumber,
          })),
          num,
          editing?.id
        )
      ) {
        setError(`Consignor #${num} is already registered for this event.`);
        return;
      }
    }

    const commission = parsedCommission();
    if (!commission.ok) {
      setError(commission.message);
      return;
    }
    const commissionRate = commission.value;
    const now = new Date();
    const fields = currentFields();
    const master = await upsertMasterConsignor(db, fields, {
      preferredSyncKey: masterSyncKey,
      now,
    });
    const linkKey = master.syncKey;
    setMasterSyncKey(linkKey);

    if (editing) {
      let existing =
        editing.id != null ? await db.consignors.get(editing.id) : undefined;
      if (!existing) {
        existing = await db.consignors
          .where("eventId")
          .equals(eventId)
          .filter((c) => c.consignorNumber === editing.consignorNumber)
          .first();
      }
      if (!existing?.id) {
        setError("Could not find this consignor. Close the form and try again.");
        return;
      }
      const next: Consignor = {
        ...existing,
        id: existing.id,
        consignorNumber: num,
        name: nm,
        phone: fields.phone,
        email: fields.email,
        notes: fields.notes,
        masterSyncKey: linkKey,
        updatedAt: now,
      };
      const ma = mailingAddress.trim();
      if (ma) next.mailingAddress = ma;
      else delete next.mailingAddress;
      if (commissionRate !== undefined) next.commissionRate = commissionRate;
      else delete next.commissionRate;
      await mutateWithParentEventTouch(db, eventId, "consignors", async () => {
        await db.consignors.put(next);
      });
    } else {
      const row: Consignor = {
        eventId,
        consignorNumber: num,
        name: nm,
        phone: fields.phone,
        email: fields.email,
        notes: fields.notes,
        masterSyncKey: linkKey,
        createdAt: now,
        updatedAt: now,
      };
      const maNew = mailingAddress.trim();
      if (maNew) row.mailingAddress = maNew;
      if (commissionRate !== undefined) row.commissionRate = commissionRate;
      await mutateWithParentEventTouch(db, eventId, "consignors", async () => {
        await db.consignors.add(row);
      });
    }
    try {
      await publishDirectoryChanges(db);
    } catch {
      /* background */
    }
    scheduleCloudPush();
    onSaved();
    onClose();
  }

  return (
    <>
      <Modal
        open={open}
        title={editing ? "Edit consignor" : "Add consignor"}
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="consignor-form" variant="primary">
              Save
            </Button>
          </>
        }
      >
        <form id="consignor-form" className="space-y-3" onSubmit={(e) => void handleSubmit(e)}>
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
            id="consignor-num"
            label="Consignor number"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={consignorNumber}
            onChange={(e) => setConsignorNumber(e.target.value)}
            required
          />
          <Input
            id="consignor-name"
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input
            id="consignor-email"
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            id="consignor-phone"
            label="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <div>
            <label
              htmlFor="consignor-mailing"
              className="mb-1 block text-sm font-medium text-ink dark:text-slate-200"
            >
              Mailing address
            </label>
            <textarea
              id="consignor-mailing"
              rows={3}
              value={mailingAddress}
              onChange={(e) => setMailingAddress(e.target.value)}
              placeholder="Street, city, state, ZIP — for mailing checks"
              className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-500"
            />
          </div>
          <Input
            id="consignor-notes"
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          <Input
            id="consignor-commission"
            label="Commission override (%)"
            type="number"
            inputMode="decimal"
            step="0.01"
            min={0}
            max={100}
            value={commissionPct}
            onChange={(e) => setCommissionPct(e.target.value)}
            placeholder="Leave blank to use event default"
          />
        </form>
      </Modal>
      <DirectoryLookupModal
        open={lookupOpen}
        title="Lookup consignor"
        description="Search the master list by name, email, or last 4 digits of phone."
        rows={masters}
        onClose={() => setLookupOpen(false)}
        onSelect={(row) => void applyLookup(row)}
        filter={(row, q) => searchMasterConsignors([row], q).length > 0}
        renderRow={(row) => ({
          primary: row.name,
          secondary: [row.email, row.phone].filter(Boolean).join(" · "),
        })}
      />
    </>
  );
}
