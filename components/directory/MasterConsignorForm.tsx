"use client";

import { useEffect, useState } from "react";
import type { MasterConsignor } from "@/lib/db";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { optTrim } from "@/lib/directory/match";
import { publishDirectoryChanges } from "@/lib/directory/sync";
import {
  consolidateMasterConsignorsByEmail,
  upsertMasterConsignor,
} from "@/lib/directory/upsert";

export function MasterConsignorForm({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: MasterConsignor | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { db } = useUserDb();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [commissionPct, setCommissionPct] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setName(editing?.name ?? "");
    setPhone(editing?.phone ?? "");
    setEmail(editing?.email ?? "");
    setMailingAddress(editing?.mailingAddress ?? "");
    setNotes(editing?.notes ?? "");
    setCommissionPct(
      typeof editing?.commissionRate === "number"
        ? String((editing.commissionRate * 100).toFixed(2).replace(/\.?0+$/, ""))
        : ""
    );
  }, [open, editing]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!db) return;
    const nm = name.trim();
    if (!nm) {
      setError("Name is required.");
      return;
    }
    let commissionRate: number | undefined;
    const cp = commissionPct.trim();
    if (cp) {
      const pct = Number(cp);
      if (Number.isNaN(pct) || pct < 0 || pct > 100) {
        setError("Commission must be between 0 and 100%.");
        return;
      }
      commissionRate = pct / 100;
    }
    setSaving(true);
    setError(null);
    try {
      await upsertMasterConsignor(
        db,
        {
          name: nm,
          phone: optTrim(phone),
          email: optTrim(email),
          mailingAddress: optTrim(mailingAddress),
          notes: optTrim(notes),
          commissionRate,
        },
        { preferredSyncKey: editing?.syncKey }
      );
      await consolidateMasterConsignorsByEmail(db);
      const pub = await publishDirectoryChanges(db);
      if (pub.conflictReplaced) {
        setError(
          "Saved locally, but another device updated Directory — refreshed from cloud. Re-apply your edit if needed."
        );
        return;
      }
      if (!pub.ok) {
        setError(
          "Saved on this device, but could not sync Directory. Stay online and try Save again."
        );
        return;
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      title={editing ? "Edit master consignor" : "Add master consignor"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="master-consignor-form" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id="master-consignor-form" className="space-y-3" onSubmit={(e) => void handleSubmit(e)}>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Input id="mc-name" label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Input id="mc-email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input id="mc-phone" label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <div>
          <label htmlFor="mc-addr" className="mb-1 block text-sm font-medium text-ink dark:text-slate-200">
            Mailing address
          </label>
          <textarea
            id="mc-addr"
            rows={3}
            value={mailingAddress}
            onChange={(e) => setMailingAddress(e.target.value)}
            className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>
        <Input id="mc-notes" label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <Input
          id="mc-comm"
          label="Default commission (%)"
          type="number"
          inputMode="decimal"
          step="0.01"
          min={0}
          max={100}
          value={commissionPct}
          onChange={(e) => setCommissionPct(e.target.value)}
        />
      </form>
    </Modal>
  );
}
