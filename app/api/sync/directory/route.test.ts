import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => ({ user: { id: "7", vendorId: "3" } })),
}));
vi.mock("@/lib/auth/options", () => ({ authOptions: {} }));

/**
 * In-memory stand-in for vendor_directory_snapshots (one vendor). Reads can be
 * held until N of them have arrived, so two saves both pass the base check
 * before either writes: the race from issue #40.
 */
const table: {
  row: { payload: string; updated_at: Date; updated_at_exact: string } | null;
  clock: number;
  holdReads: number;
  waiting: Array<() => void>;
} = { row: null, clock: 0, holdReads: 0, waiting: [] };

function exact(d: Date): string {
  // Postgres text output keeps microseconds; fake it with a suffix the Date
  // round-trip would lose.
  return `${d.toISOString()}+123us`;
}

vi.mock("@/lib/db/postgres", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("SELECT updated_at")) {
      const payloadJson = values[0] as string;
      if (table.holdReads > 0) {
        table.holdReads -= 1;
        await new Promise<void>((resolve) => {
          table.waiting.push(resolve);
          if (table.holdReads === 0) table.waiting.splice(0).forEach((r) => r());
        });
      }
      const r = table.row;
      return {
        rows: r
          ? [
              {
                updated_at: r.updated_at,
                updated_at_exact: r.updated_at_exact,
                payload: JSON.parse(r.payload),
                same: r.payload === payloadJson,
              },
            ]
          : [],
      };
    }
    if (text.includes("INSERT INTO vendor_directory_snapshots")) {
      const payloadJson = values[2] as string;
      const conditional = text.includes("WHERE vendor_directory_snapshots.updated_at = ");
      const expected = values[values.length - 1] as string | null;
      if (conditional && table.row && table.row.updated_at_exact !== expected) {
        return { rows: [] };
      }
      table.clock += 1000;
      const now = new Date(Date.UTC(2026, 9, 18, 4, 0, 0) + table.clock);
      table.row = { payload: payloadJson, updated_at: now, updated_at_exact: exact(now) };
      return { rows: [{ updated_at: now }] };
    }
    throw new Error(`unexpected query: ${text}`);
  }),
}));

import { POST } from "./route";

function save(payload: object, baseUpdatedAt: string | null) {
  return POST(
    new Request("http://localhost/api/sync/directory/", {
      method: "POST",
      body: JSON.stringify({ payload, baseUpdatedAt }),
    })
  );
}

const dirA = { version: 1, bidders: [{ name: "A" }], consignors: [] };
const dirB = { version: 1, bidders: [{ name: "B" }], consignors: [] };
const dirBase = { version: 1, bidders: [], consignors: [] };

describe("POST /api/sync/directory", () => {
  beforeEach(() => {
    table.row = null;
    table.clock = 0;
    table.holdReads = 0;
    table.waiting = [];
  });

  it("two saves from the same base: one 200, one 409 with the winner's payload", async () => {
    const first = await save(dirBase, null);
    expect(first.status).toBe(200);
    const base = ((await first.json()) as { updatedAt: string }).updatedAt;

    table.holdReads = 2;
    const [a, b] = await Promise.all([save(dirA, base), save(dirB, base)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    const body = (await loser.json()) as { error: string; payload: unknown };
    expect(body.error).toBe("stale_base");
    const winnerPayload = a.status === 200 ? dirA : dirB;
    expect(body.payload).toEqual(winnerPayload);
    expect(JSON.parse(table.row!.payload)).toEqual(winnerPayload);
  });

  it("two first-ever saves for a team: the second does not overwrite the first", async () => {
    table.holdReads = 2;
    const [a, b] = await Promise.all([save(dirA, null), save(dirB, null)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winnerPayload = a.status === 200 ? dirA : dirB;
    expect(JSON.parse(table.row!.payload)).toEqual(winnerPayload);
  });

  it("losing the race with an identical payload is treated as unchanged", async () => {
    const first = await save(dirBase, null);
    const base = ((await first.json()) as { updatedAt: string }).updatedAt;

    table.holdReads = 2;
    const [a, b] = await Promise.all([save(dirA, base), save(dirA, base)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = (await Promise.all([a.json(), b.json()])) as Array<{
      unchanged?: boolean;
    }>;
    expect(bodies.filter((x) => x.unchanged).length).toBe(1);
  });

  it("a normal save from a current base still succeeds", async () => {
    const first = await save(dirBase, null);
    const base = ((await first.json()) as { updatedAt: string }).updatedAt;
    const second = await save(dirA, base);
    expect(second.status).toBe(200);
    expect(JSON.parse(table.row!.payload)).toEqual(dirA);
  });

  it("a save from an old base still gets 409 before writing", async () => {
    await save(dirBase, null);
    const res = await save(dirA, "2026-10-01T00:00:00.000Z");
    expect(res.status).toBe(409);
    expect(JSON.parse(table.row!.payload)).toEqual(dirBase);
  });
});
