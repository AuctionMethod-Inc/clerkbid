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

/**
 * True when two event snapshots describe the same auction data.
 * Ignores export timestamps, cloud baselines, and local Dexie ids so idle
 * re-exports do not bump `updated_at` or publish Ably.
 */
export function eventSnapshotsContentEqual(a: unknown, b: unknown): boolean {
  return stableStringify(stripVolatile(a)) === stableStringify(stripVolatile(b));
}
