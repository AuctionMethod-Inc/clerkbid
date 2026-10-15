import type { AuctionDB, MasterBidder, MasterConsignor } from "@/lib/db";
import { newEntitySyncKey } from "@/lib/utils/clientSyncKey";
import { digitsOnly, normalizeEmail, optTrim } from "@/lib/directory/match";

export type MasterBidderFields = {
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  mailingAddress?: string;
  resaleNumber?: string;
};

export type MasterConsignorFields = {
  name: string;
  email?: string;
  phone?: string;
  mailingAddress?: string;
  notes?: string;
  commissionRate?: number;
};

function samePhone(
  a: string | undefined,
  b: string | undefined
): boolean {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  return da.length >= 7 && da === db;
}

function safeMs(d: Date | string | number | undefined | null): number {
  const parsed = d instanceof Date ? d : d != null ? new Date(d) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : 0;
}

export async function findMasterBidder(
  db: AuctionDB,
  fields: Pick<MasterBidderFields, "email" | "phone">
): Promise<MasterBidder | undefined> {
  const email = normalizeEmail(fields.email);
  const all = await db.masterBidders.toArray();
  if (email) {
    const byEmail = all.find((m) => normalizeEmail(m.email) === email);
    if (byEmail) return byEmail;
  }
  if (digitsOnly(fields.phone).length >= 7) {
    return all.find((m) => samePhone(m.phone, fields.phone));
  }
  return undefined;
}

export async function findMasterConsignor(
  db: AuctionDB,
  fields: Pick<MasterConsignorFields, "email" | "phone">
): Promise<MasterConsignor | undefined> {
  const email = normalizeEmail(fields.email);
  const all = await db.masterConsignors.toArray();
  if (email) {
    const byEmail = all.find((m) => normalizeEmail(m.email) === email);
    if (byEmail) return byEmail;
  }
  if (digitsOnly(fields.phone).length >= 7) {
    return all.find((m) => samePhone(m.phone, fields.phone));
  }
  return undefined;
}

function bidderPatch(
  fields: MasterBidderFields,
  now: Date
): Omit<MasterBidder, "id" | "syncKey" | "createdAt"> {
  return {
    firstName: fields.firstName.trim(),
    lastName: fields.lastName.trim(),
    phone: optTrim(fields.phone),
    email: optTrim(fields.email),
    mailingAddress: optTrim(fields.mailingAddress),
    resaleNumber: optTrim(fields.resaleNumber),
    updatedAt: now,
  };
}

function consignorPatch(
  fields: MasterConsignorFields,
  now: Date
): Partial<MasterConsignor> {
  const patch: Partial<MasterConsignor> = {
    name: fields.name.trim(),
    phone: optTrim(fields.phone),
    email: optTrim(fields.email),
    mailingAddress: optTrim(fields.mailingAddress),
    notes: optTrim(fields.notes),
    updatedAt: now,
  };
  if (fields.commissionRate !== undefined) {
    patch.commissionRate = fields.commissionRate;
  }
  return patch;
}

async function repointBidderMasterLinks(
  db: AuctionDB,
  fromSyncKey: string,
  toSyncKey: string
): Promise<void> {
  if (fromSyncKey === toSyncKey) return;
  const linked = await db.bidders.where("masterSyncKey").equals(fromSyncKey).toArray();
  for (const b of linked) {
    if (b.id != null) {
      await db.bidders.update(b.id, { masterSyncKey: toSyncKey });
    }
  }
}

async function repointConsignorMasterLinks(
  db: AuctionDB,
  fromSyncKey: string,
  toSyncKey: string
): Promise<void> {
  if (fromSyncKey === toSyncKey) return;
  const linked = await db.consignors
    .where("masterSyncKey")
    .equals(fromSyncKey)
    .toArray();
  for (const c of linked) {
    if (c.id != null) {
      await db.consignors.update(c.id, { masterSyncKey: toSyncKey });
    }
  }
}

/**
 * Find by email (preferred), else preferredSyncKey, else phone.
 * Updates the matched master with the latest fields so Directory stays current.
 * If email matches a different record than preferredSyncKey, merges into the
 * email-canonical row and removes the preferred duplicate.
 */
export async function upsertMasterBidder(
  db: AuctionDB,
  fields: MasterBidderFields,
  options?: { preferredSyncKey?: string; now?: Date }
): Promise<MasterBidder> {
  const now = options?.now ?? new Date();
  const email = normalizeEmail(fields.email);
  const all = await db.masterBidders.toArray();
  const preferred = options?.preferredSyncKey
    ? all.find((m) => m.syncKey === options.preferredSyncKey)
    : undefined;

  let existing: MasterBidder | undefined;
  if (email) {
    existing = all.find((m) => normalizeEmail(m.email) === email);
  }
  if (!existing && preferred) existing = preferred;
  if (!existing && digitsOnly(fields.phone).length >= 7) {
    existing = all.find((m) => samePhone(m.phone, fields.phone));
  }

  const patch = bidderPatch(fields, now);

  if (existing?.id != null) {
    if (
      preferred &&
      preferred.id != null &&
      preferred.syncKey !== existing.syncKey
    ) {
      await repointBidderMasterLinks(db, preferred.syncKey, existing.syncKey);
      await db.masterBidders.delete(preferred.id);
    }
    await db.masterBidders.update(existing.id, patch);
    return { ...existing, ...patch, id: existing.id };
  }

  const row: MasterBidder = {
    syncKey: preferred?.syncKey ?? newEntitySyncKey(),
    ...patch,
    createdAt: now,
  };
  const id = (await db.masterBidders.add(row)) as number;
  return { ...row, id };
}

/**
 * @deprecated Prefer upsertMasterBidder — kept as an alias that updates on match.
 */
export async function findOrCreateMasterBidder(
  db: AuctionDB,
  fields: MasterBidderFields,
  now: Date = new Date()
): Promise<MasterBidder> {
  return upsertMasterBidder(db, fields, { now });
}

export async function upsertMasterConsignor(
  db: AuctionDB,
  fields: MasterConsignorFields,
  options?: { preferredSyncKey?: string; now?: Date }
): Promise<MasterConsignor> {
  const now = options?.now ?? new Date();
  const email = normalizeEmail(fields.email);
  const all = await db.masterConsignors.toArray();
  const preferred = options?.preferredSyncKey
    ? all.find((m) => m.syncKey === options.preferredSyncKey)
    : undefined;

  let existing: MasterConsignor | undefined;
  if (email) {
    existing = all.find((m) => normalizeEmail(m.email) === email);
  }
  if (!existing && preferred) existing = preferred;
  if (!existing && digitsOnly(fields.phone).length >= 7) {
    existing = all.find((m) => samePhone(m.phone, fields.phone));
  }

  const patch = consignorPatch(fields, now);

  if (existing?.id != null) {
    if (
      preferred &&
      preferred.id != null &&
      preferred.syncKey !== existing.syncKey
    ) {
      await repointConsignorMasterLinks(db, preferred.syncKey, existing.syncKey);
      await db.masterConsignors.delete(preferred.id);
    }
    await db.masterConsignors.update(existing.id, patch);
    return { ...existing, ...patch, id: existing.id };
  }

  const row: MasterConsignor = {
    syncKey: preferred?.syncKey ?? newEntitySyncKey(),
    name: fields.name.trim(),
    phone: optTrim(fields.phone),
    email: optTrim(fields.email),
    mailingAddress: optTrim(fields.mailingAddress),
    notes: optTrim(fields.notes),
    commissionRate: fields.commissionRate,
    createdAt: now,
    updatedAt: now,
  };
  const id = (await db.masterConsignors.add(row)) as number;
  return { ...row, id };
}

export async function findOrCreateMasterConsignor(
  db: AuctionDB,
  fields: MasterConsignorFields,
  now: Date = new Date()
): Promise<MasterConsignor> {
  return upsertMasterConsignor(db, fields, { now });
}

export async function updateMasterBidderFromEvent(
  db: AuctionDB,
  masterSyncKey: string,
  fields: MasterBidderFields,
  now: Date = new Date()
): Promise<boolean> {
  const row = await upsertMasterBidder(db, fields, {
    preferredSyncKey: masterSyncKey,
    now,
  });
  return row.id != null;
}

export async function updateMasterConsignorFromEvent(
  db: AuctionDB,
  masterSyncKey: string,
  fields: MasterConsignorFields,
  now: Date = new Date()
): Promise<boolean> {
  const row = await upsertMasterConsignor(db, fields, {
    preferredSyncKey: masterSyncKey,
    now,
  });
  return row.id != null;
}

/**
 * Collapse master bidders that share the same normalized email into one row.
 * Also merges rows that share a phone (7+ digits) when emails do not conflict
 * (same email, or one/both missing). Keeps the newest `updatedAt`, fills blank
 * fields from losers, re-points event links, deletes the rest.
 */
export async function consolidateMasterBiddersByEmail(
  db: AuctionDB
): Promise<{ removed: number }> {
  let removed = 0;
  removed += await consolidateBidderGroups(db, groupMasterBiddersByEmail);
  removed += await consolidateBidderGroups(db, groupMasterBiddersByPhone);
  return { removed };
}

function groupMasterBiddersByEmail(
  all: MasterBidder[]
): MasterBidder[][] {
  const byEmail = new Map<string, MasterBidder[]>();
  for (let i = 0; i < all.length; i++) {
    const m = all[i]!;
    const e = normalizeEmail(m.email);
    if (!e) continue;
    const list = byEmail.get(e) ?? [];
    list.push(m);
    byEmail.set(e, list);
  }
  return Array.from(byEmail.values()).filter((g) => g.length >= 2);
}

function emailsCompatible(
  a: string | undefined,
  b: string | undefined
): boolean {
  const na = normalizeEmail(a);
  const nb = normalizeEmail(b);
  if (!na || !nb) return true;
  return na === nb;
}

function groupMasterBiddersByPhone(
  all: MasterBidder[]
): MasterBidder[][] {
  const byPhone = new Map<string, MasterBidder[]>();
  for (let i = 0; i < all.length; i++) {
    const m = all[i]!;
    const phone = digitsOnly(m.phone);
    if (phone.length < 7) continue;
    const list = byPhone.get(phone) ?? [];
    list.push(m);
    byPhone.set(phone, list);
  }
  const groups = Array.from(byPhone.values()).filter((g) => g.length >= 2);
  const out: MasterBidder[][] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    let compatible = true;
    for (let j = 0; j < group.length && compatible; j++) {
      for (let k = j + 1; k < group.length; k++) {
        if (!emailsCompatible(group[j]!.email, group[k]!.email)) {
          compatible = false;
          break;
        }
      }
    }
    if (compatible) out.push(group);
  }
  return out;
}

function sortMastersNewestFirst<T extends { updatedAt: Date; createdAt: Date }>(
  group: T[]
): T[] {
  return group.slice().sort((a, b) => {
    const byUpdated = safeMs(b.updatedAt) - safeMs(a.updatedAt);
    if (byUpdated !== 0) return byUpdated;
    return safeMs(a.createdAt) - safeMs(b.createdAt);
  });
}

function pickBidderField(
  winner: MasterBidder,
  losers: MasterBidder[],
  key: "phone" | "email" | "mailingAddress" | "resaleNumber"
): string | undefined {
  const own = optTrim(winner[key]);
  if (own) return own;
  for (let i = 0; i < losers.length; i++) {
    const v = optTrim(losers[i]![key]);
    if (v) return v;
  }
  return undefined;
}

async function consolidateBidderGroups(
  db: AuctionDB,
  groupFn: (all: MasterBidder[]) => MasterBidder[][]
): Promise<number> {
  const all = await db.masterBidders.toArray();
  const groups = groupFn(all);
  let removed = 0;
  for (let i = 0; i < groups.length; i++) {
    const sorted = sortMastersNewestFirst(groups[i]!);
    const winner = sorted[0]!;
    const losers = sorted.slice(1);
    const patch: Partial<MasterBidder> = {
      phone: pickBidderField(winner, losers, "phone"),
      email: pickBidderField(winner, losers, "email"),
      mailingAddress: pickBidderField(winner, losers, "mailingAddress"),
      resaleNumber: pickBidderField(winner, losers, "resaleNumber"),
    };
    if (winner.id != null) {
      await db.masterBidders.update(winner.id, patch);
    }
    for (let j = 0; j < losers.length; j++) {
      const loser = losers[j]!;
      await repointBidderMasterLinks(db, loser.syncKey, winner.syncKey);
      const deleted = await db.masterBidders
        .where("syncKey")
        .equals(loser.syncKey)
        .delete();
      removed += deleted;
    }
  }
  return removed;
}

export async function consolidateMasterConsignorsByEmail(
  db: AuctionDB
): Promise<{ removed: number }> {
  let removed = 0;
  removed += await consolidateConsignorGroups(db, groupMasterConsignorsByEmail);
  removed += await consolidateConsignorGroups(db, groupMasterConsignorsByPhone);
  return { removed };
}

function groupMasterConsignorsByEmail(
  all: MasterConsignor[]
): MasterConsignor[][] {
  const byEmail = new Map<string, MasterConsignor[]>();
  for (let i = 0; i < all.length; i++) {
    const m = all[i]!;
    const e = normalizeEmail(m.email);
    if (!e) continue;
    const list = byEmail.get(e) ?? [];
    list.push(m);
    byEmail.set(e, list);
  }
  return Array.from(byEmail.values()).filter((g) => g.length >= 2);
}

function groupMasterConsignorsByPhone(
  all: MasterConsignor[]
): MasterConsignor[][] {
  const byPhone = new Map<string, MasterConsignor[]>();
  for (let i = 0; i < all.length; i++) {
    const m = all[i]!;
    const phone = digitsOnly(m.phone);
    if (phone.length < 7) continue;
    const list = byPhone.get(phone) ?? [];
    list.push(m);
    byPhone.set(phone, list);
  }
  const groups = Array.from(byPhone.values()).filter((g) => g.length >= 2);
  const out: MasterConsignor[][] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    let compatible = true;
    for (let j = 0; j < group.length && compatible; j++) {
      for (let k = j + 1; k < group.length; k++) {
        if (!emailsCompatible(group[j]!.email, group[k]!.email)) {
          compatible = false;
          break;
        }
      }
    }
    if (compatible) out.push(group);
  }
  return out;
}

function pickConsignorField(
  winner: MasterConsignor,
  losers: MasterConsignor[],
  key: "phone" | "email" | "mailingAddress" | "notes"
): string | undefined {
  const own = optTrim(winner[key]);
  if (own) return own;
  for (let i = 0; i < losers.length; i++) {
    const v = optTrim(losers[i]![key]);
    if (v) return v;
  }
  return undefined;
}

async function consolidateConsignorGroups(
  db: AuctionDB,
  groupFn: (all: MasterConsignor[]) => MasterConsignor[][]
): Promise<number> {
  const all = await db.masterConsignors.toArray();
  const groups = groupFn(all);
  let removed = 0;
  for (let i = 0; i < groups.length; i++) {
    const sorted = sortMastersNewestFirst(groups[i]!);
    const winner = sorted[0]!;
    const losers = sorted.slice(1);
    const patch: Partial<MasterConsignor> = {
      phone: pickConsignorField(winner, losers, "phone"),
      email: pickConsignorField(winner, losers, "email"),
      mailingAddress: pickConsignorField(winner, losers, "mailingAddress"),
      notes: pickConsignorField(winner, losers, "notes"),
    };
    if (winner.commissionRate == null) {
      for (let j = 0; j < losers.length; j++) {
        if (losers[j]!.commissionRate != null) {
          patch.commissionRate = losers[j]!.commissionRate;
          break;
        }
      }
    }
    if (winner.id != null) {
      await db.masterConsignors.update(winner.id, patch);
    }
    for (let j = 0; j < losers.length; j++) {
      const loser = losers[j]!;
      await repointConsignorMasterLinks(db, loser.syncKey, winner.syncKey);
      const deleted = await db.masterConsignors
        .where("syncKey")
        .equals(loser.syncKey)
        .delete();
      removed += deleted;
    }
  }
  return removed;
}

export async function consolidateDirectoryDuplicates(
  db: AuctionDB
): Promise<{ biddersRemoved: number; consignorsRemoved: number }> {
  const bidders = await consolidateMasterBiddersByEmail(db);
  const consignors = await consolidateMasterConsignorsByEmail(db);
  return {
    biddersRemoved: bidders.removed,
    consignorsRemoved: consignors.removed,
  };
}

/** Delete master bidders by syncKey; clear event links; does not touch event roster rows otherwise. */
export async function deleteMasterBidders(
  db: AuctionDB,
  syncKeys: string[]
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < syncKeys.length; i++) {
    const key = syncKeys[i]!;
    if (!key) continue;
    await db.bidders
      .where("masterSyncKey")
      .equals(key)
      .modify((b) => {
        delete b.masterSyncKey;
      });
    removed += await db.masterBidders.where("syncKey").equals(key).delete();
  }
  return removed;
}

/** Delete master consignors by syncKey; clear event links. */
export async function deleteMasterConsignors(
  db: AuctionDB,
  syncKeys: string[]
): Promise<number> {
  let removed = 0;
  for (let i = 0; i < syncKeys.length; i++) {
    const key = syncKeys[i]!;
    if (!key) continue;
    await db.consignors
      .where("masterSyncKey")
      .equals(key)
      .modify((c) => {
        delete c.masterSyncKey;
      });
    removed += await db.masterConsignors.where("syncKey").equals(key).delete();
  }
  return removed;
}

export async function findEventBidderByMaster(
  db: AuctionDB,
  eventId: number,
  masterSyncKey: string
) {
  return db.bidders
    .where("[eventId+masterSyncKey]")
    .equals([eventId, masterSyncKey])
    .first();
}

export async function findEventConsignorByMaster(
  db: AuctionDB,
  eventId: number,
  masterSyncKey: string
) {
  return db.consignors
    .where("[eventId+masterSyncKey]")
    .equals([eventId, masterSyncKey])
    .first();
}

export function masterBidderFieldsDiffer(
  master: MasterBidder,
  fields: MasterBidderFields
): boolean {
  return (
    master.firstName.trim() !== fields.firstName.trim() ||
    master.lastName.trim() !== fields.lastName.trim() ||
    (optTrim(master.phone) ?? "") !== (optTrim(fields.phone) ?? "") ||
    (optTrim(master.email) ?? "") !== (optTrim(fields.email) ?? "") ||
    (optTrim(master.mailingAddress) ?? "") !==
      (optTrim(fields.mailingAddress) ?? "") ||
    (optTrim(master.resaleNumber) ?? "") !== (optTrim(fields.resaleNumber) ?? "")
  );
}

export function masterConsignorFieldsDiffer(
  master: MasterConsignor,
  fields: MasterConsignorFields
): boolean {
  const masterPct = master.commissionRate;
  const fieldPct = fields.commissionRate;
  const commissionDiff =
    masterPct !== fieldPct &&
    !(masterPct == null && fieldPct == null);
  return (
    master.name.trim() !== fields.name.trim() ||
    (optTrim(master.phone) ?? "") !== (optTrim(fields.phone) ?? "") ||
    (optTrim(master.email) ?? "") !== (optTrim(fields.email) ?? "") ||
    (optTrim(master.mailingAddress) ?? "") !==
      (optTrim(fields.mailingAddress) ?? "") ||
    (optTrim(master.notes) ?? "") !== (optTrim(fields.notes) ?? "") ||
    commissionDiff
  );
}
