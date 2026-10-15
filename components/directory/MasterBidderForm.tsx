"use client";

import { useEffect, useState } from "react";
import type { MasterBidder } from "@/lib/db";
import { useUserDb } from "@/components/providers/UserDbProvider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { optTrim } from "@/lib/directory/match";
import { publishDirectoryChanges } from "@/lib/directory/sync";
import {
  consolidateMasterBiddersByEmail,
  upsertMasterBidder,
} from "@/lib/directory/upsert";

export function MasterBidderForm({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: MasterBidder | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { db } = useUserDb();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [mailingAddress, setMailingAddress] = useState("");
  const [resaleNumber, setResaleNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setFirstName(editing?.firstName ?? "");
    setLastName(editing?.lastName ?? "");
    setPhone(editing?.phone ?? "");
    setEmail(editing?.email ?? "");
    setMailingAddress(editing?.mailingAddress ?? "");
    setResaleNumber(editing?.resaleNumber ?? "");
  }, [open, editing]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!db) return;
    const fn = firstName.trim();
    const ln = lastName.trim();
    if (!fn || !ln) {
      setError("First and last name are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await upsertMasterBidder(
        db,
        {
          firstName: fn,
          lastName: ln,
          phone: optTrim(phone),
          email: optTrim(email),
          mailingAddress: optTrim(mailingAddress),
          resaleNumber: optTrim(resaleNumber),
        },
        { preferredSyncKey: editing?.syncKey }
      );
      await consolidateMasterBiddersByEmail(db);
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
      title={editing ? "Edit master bidder" : "Add master bidder"}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="master-bidder-form" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <form id="master-bidder-form" className="space-y-3" onSubmit={(e) => void handleSubmit(e)}>
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
        <Input id="mb-fn" label="First name" value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
        <Input id="mb-ln" label="Last name" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        <Input id="mb-phone" label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Input id="mb-email" label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div>
          <label htmlFor="mb-addr" className="mb-1 block text-sm font-medium text-ink dark:text-slate-200">
            Address
          </label>
          <textarea
            id="mb-addr"
            rows={3}
            value={mailingAddress}
            onChange={(e) => setMailingAddress(e.target.value)}
            className="w-full rounded-lg border border-navy/20 bg-white px-3 py-2 text-sm text-ink focus:border-navy focus:outline-none focus:ring-1 focus:ring-navy dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
          />
        </div>
        <Input id="mb-resale" label="Resale number" value={resaleNumber} onChange={(e) => setResaleNumber(e.target.value)} />
      </form>
    </Modal>
  );
}
