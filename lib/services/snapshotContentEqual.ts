/** Fields that change on every idle export or after Dexie re-insert, not real event data. */
const VOLATILE_SNAPSHOT_KEYS = new Set([
  "exportDate",
  "lastCloudPushAt",
  "lastCloudPullAt",
  "legacyId",
  "legacyBidderId",
  "legacyLotId",
  "legacyConsignorId",
  "legacyInvoiceId",
]);

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_SNAPSHOT_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rowsOf(payload: Row, key: string): Row[] {
  const list = payload[key];
  return Array.isArray(list) ? list.filter(isRow) : [];
}

/** Map rows of `payload[key]`, leaving anything that is not a row as is. */
function mapRows(payload: Row, key: string, fn: (row: Row) => Row): unknown[] {
  return (payload[key] as unknown[]).map((r) => (isRow(r) ? fn(r) : r));
}

/** Map each row's local `legacyId` to a key that is the same on every device. */
function stableKeyByLegacyId(
  rows: Row[],
  stableKey: (row: Row) => unknown
): Map<unknown, unknown> {
  const out = new Map<unknown, unknown>();
  for (const r of rows) {
    if (r.legacyId != null) out.set(r.legacyId, stableKey(r));
  }
  return out;
}

/**
 * Stable form of one link: the target's natural key. A link to a record that is
 * not in the event compares the same as no link: devices disagree on whether a
 * deleted target leaves a dangling id or null, and idle devices must agree.
 */
function resolveLink(
  map: Map<unknown, unknown>,
  legacyId: unknown
): unknown {
  if (legacyId == null) return null;
  return map.has(legacyId) ? map.get(legacyId) : null;
}

/**
 * Links between records are exported only as local Dexie ids (`legacy*Id`),
 * which differ per device and are dropped by `stripVolatile`. Copy each link
 * as the target's natural key (paddle number, consignor number, lot number,
 * invoice sync key) so a link-only edit still compares as a change.
 * Comparison only: the stored snapshot is untouched.
 */
function withStableLinks(payload: unknown): unknown {
  if (!isRow(payload)) return payload;
  const p = payload;
  const bidders = stableKeyByLegacyId(rowsOf(p, "bidders"), (r) => r.paddleNumber);
  const consignors = stableKeyByLegacyId(
    rowsOf(p, "consignors"),
    (r) => r.consignorNumber
  );
  const lots = stableKeyByLegacyId(rowsOf(p, "lots"), (r) => r.displayLotNumber);
  const invoices = stableKeyByLegacyId(
    rowsOf(p, "invoices"),
    (r) => r.syncKey ?? r.invoiceNumber
  );

  const out: Row = { ...p };
  if (Array.isArray(p.lots)) {
    out.lots = mapRows(p, "lots", (l) => ({
      ...l,
      linkConsignor: resolveLink(consignors, l.legacyConsignorId),
    }));
  }
  if (Array.isArray(p.sales)) {
    out.sales = mapRows(p, "sales", (s) => ({
      ...s,
      linkLot: resolveLink(lots, s.legacyLotId),
      linkBidder: resolveLink(bidders, s.legacyBidderId),
      linkConsignor: resolveLink(consignors, s.legacyConsignorId),
      linkInvoice: resolveLink(invoices, s.legacyInvoiceId),
    }));
  }
  if (Array.isArray(p.invoices)) {
    out.invoices = mapRows(p, "invoices", (inv) => ({
      ...inv,
      linkBidder: resolveLink(bidders, inv.legacyBidderId),
    }));
  }
  return out;
}

function comparable(snapshot: unknown): string {
  return stableStringify(stripVolatile(withStableLinks(snapshot)));
}

/**
 * True when two event snapshots describe the same auction data.
 * Ignores export timestamps, cloud baselines, and local Dexie ids so idle
 * re-exports do not bump `updated_at` or publish Ably. Links between records
 * are compared by natural key, so moving a sale to another invoice or linking
 * a lot to a consignor is still a change.
 */
export function eventSnapshotsContentEqual(a: unknown, b: unknown): boolean {
  return comparable(a) === comparable(b);
}
