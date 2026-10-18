import { describe, expect, it } from "vitest";
import type { TxClient } from "@/lib/db/postgres";
import { ATTACHMENT_LIMITS } from "./attachments";
import { claimUploadToken } from "./uploadTokens";

/**
 * In-memory stand-in for feedback_upload_tokens. Each transaction holds the
 * advisory lock from the lock query until it ends, as pg_advisory_xact_lock
 * does, so parallel claims run the way they would against Postgres.
 */
function fakeDb(initialRows: { user_id: number }[] = []) {
  const rows = [...initialRows];
  const locks = new Map<string, Promise<void>>();
  const queries: string[] = [];

  async function transaction<T>(fn: (client: TxClient) => Promise<T>): Promise<T> {
    let release: () => void = () => {};
    const client = {
      sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        queries.push(text.trim().split(/\s+/)[0]!);
        if (text.includes("pg_advisory_xact_lock")) {
          const key = String(values[0]);
          const held = locks.get(key) ?? Promise.resolve();
          const mine = new Promise<void>((r) => (release = r));
          locks.set(key, held.then(() => mine));
          await held;
          return { rows: [] };
        }
        // Yield between statements so parallel transactions interleave.
        await new Promise((r) => setTimeout(r, 0));
        if (text.includes("COUNT(*)")) {
          const n = rows.filter((r) => r.user_id === values[0]).length;
          return { rows: [{ n: String(n) }] };
        }
        if (text.includes("INSERT")) {
          rows.push({ user_id: values[0] as number });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
      query: async () => undefined,
    } as unknown as TxClient;
    try {
      return await fn(client);
    } finally {
      release();
    }
  }

  return { rows, queries, transaction };
}

const CAP = ATTACHMENT_LIMITS.maxUploadsPerDay;

describe("claimUploadToken", () => {
  it("records a permission under the cap, locking before it counts", async () => {
    const db = fakeDb();
    expect(await db.transaction((c) => claimUploadToken(c, 7))).toBe(true);
    expect(db.rows).toEqual([{ user_id: 7 }]);
    expect(db.queries).toEqual(["SELECT", "SELECT", "INSERT"]);
  });

  it("refuses at the cap and records nothing", async () => {
    const db = fakeDb(Array.from({ length: CAP }, () => ({ user_id: 7 })));
    expect(await db.transaction((c) => claimUploadToken(c, 7))).toBe(false);
    expect(db.rows).toHaveLength(CAP);
  });

  it("counts each user separately", async () => {
    const db = fakeDb(Array.from({ length: CAP }, () => ({ user_id: 7 })));
    expect(await db.transaction((c) => claimUploadToken(c, 8))).toBe(true);
  });

  it("stops parallel requests at the cap", async () => {
    const db = fakeDb();
    const results = await Promise.all(
      Array.from({ length: CAP + 10 }, () => db.transaction((c) => claimUploadToken(c, 7)))
    );
    expect(results.filter(Boolean)).toHaveLength(CAP);
    expect(db.rows).toHaveLength(CAP);
  });
});
