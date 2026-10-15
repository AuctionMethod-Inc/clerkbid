import type { MasterBidder, MasterConsignor } from "@/lib/db";
import { toDate } from "@/lib/utils/coerceDate";

export const DIRECTORY_EXPORT_VERSION = 1;

export type DirectoryExportPayload = {
  exportVersion: number;
  exportDate: string;
  bidders: Array<
    Omit<MasterBidder, "id" | "createdAt" | "updatedAt"> & {
      createdAt: string;
      updatedAt: string;
    }
  >;
  consignors: Array<
    Omit<MasterConsignor, "id" | "createdAt" | "updatedAt"> & {
      createdAt: string;
      updatedAt: string;
    }
  >;
};

function iso(d: Date | string | number | undefined | null, field: string): string {
  const parsed = toDate(d);
  if (!parsed) throw new Error(`Invalid date for directory export (${field})`);
  return parsed.toISOString();
}

export function parseDirectoryDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function isDirectoryExportPayload(
  value: unknown
): value is DirectoryExportPayload {
  if (value == null || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.exportVersion === "number" &&
    Array.isArray(o.bidders) &&
    Array.isArray(o.consignors)
  );
}

export async function buildDirectoryExport(
  bidders: MasterBidder[],
  consignors: MasterConsignor[]
): Promise<DirectoryExportPayload> {
  return {
    exportVersion: DIRECTORY_EXPORT_VERSION,
    exportDate: new Date().toISOString(),
    bidders: bidders.map(({ id: _id, ...b }) => ({
      ...b,
      createdAt: iso(b.createdAt, "masterBidder.createdAt"),
      updatedAt: iso(b.updatedAt, "masterBidder.updatedAt"),
    })),
    consignors: consignors.map(({ id: _id, ...c }) => ({
      ...c,
      createdAt: iso(c.createdAt, "masterConsignor.createdAt"),
      updatedAt: iso(c.updatedAt, "masterConsignor.updatedAt"),
    })),
  };
}
