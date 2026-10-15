import type { MasterBidder, MasterConsignor } from "@/lib/db";
import {
  matchesNameQuery,
  matchesPhoneLast4,
  matchesSingleNameQuery,
  normalizeEmail,
} from "@/lib/directory/match";

export type DirectoryBidderFilter = "all" | "hasResale" | "hasEmail";
export type DirectoryConsignorFilter = "all" | "hasEmail" | "hasAddress";

export function searchMasterBidders(
  rows: MasterBidder[],
  query: string
): MasterBidder[] {
  const q = query.trim();
  if (!q) return rows;
  const qLower = q.toLowerCase();
  const emailQ = normalizeEmail(q);
  return rows.filter((b) => {
    if (matchesNameQuery(b.firstName, b.lastName, q)) return true;
    if (b.email && normalizeEmail(b.email).includes(emailQ)) return true;
    if (matchesPhoneLast4(b.phone, q)) return true;
    if (b.resaleNumber?.toLowerCase().includes(qLower)) return true;
    if (b.mailingAddress?.toLowerCase().includes(qLower)) return true;
    return false;
  });
}

export function searchMasterConsignors(
  rows: MasterConsignor[],
  query: string
): MasterConsignor[] {
  const q = query.trim();
  if (!q) return rows;
  const qLower = q.toLowerCase();
  const emailQ = normalizeEmail(q);
  return rows.filter((c) => {
    if (matchesSingleNameQuery(c.name, q)) return true;
    if (c.email && normalizeEmail(c.email).includes(emailQ)) return true;
    if (matchesPhoneLast4(c.phone, q)) return true;
    if (c.mailingAddress?.toLowerCase().includes(qLower)) return true;
    if (c.notes?.toLowerCase().includes(qLower)) return true;
    return false;
  });
}

export function filterMasterBidders(
  rows: MasterBidder[],
  filter: DirectoryBidderFilter,
  usedInEventKeys?: Set<string>
): MasterBidder[] {
  switch (filter) {
    case "hasResale":
      return rows.filter((b) => Boolean(b.resaleNumber?.trim()));
    case "hasEmail":
      return rows.filter((b) => Boolean(b.email?.trim()));
    default:
      if (usedInEventKeys && usedInEventKeys.size > 0) {
        /* "all" keeps everyone; event filter applied separately */
      }
      return rows;
  }
}

export function inCurrentEventOnly<T extends { syncKey: string }>(
  rows: T[],
  usedInEventKeys: Set<string> | undefined,
  enabled: boolean
): T[] {
  if (!enabled || !usedInEventKeys) return rows;
  return rows.filter((r) => usedInEventKeys.has(r.syncKey));
}

export function filterMasterConsignors(
  rows: MasterConsignor[],
  filter: DirectoryConsignorFilter
): MasterConsignor[] {
  switch (filter) {
    case "hasEmail":
      return rows.filter((c) => Boolean(c.email?.trim()));
    case "hasAddress":
      return rows.filter((c) => Boolean(c.mailingAddress?.trim()));
    default:
      return rows;
  }
}
