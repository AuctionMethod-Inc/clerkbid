import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => ({ user: { id: "7", vendorId: "3" } })),
}));
vi.mock("@/lib/auth/options", () => ({ authOptions: {} }));
vi.mock("@/lib/ably/publishEventSync", () => ({
  publishEventSyncNudge: vi.fn(),
}));

/**
 * In-memory stand-in for event_cloud_snapshots (one event). Reads of the
 * current row can be held until N of them have arrived, so two saves both pass
 * the checks before either writes.
 */
const table: {
  row: { payload: string; updated_at: Date; updated_at_exact: string } | null;
  clock: number;
  holdReads: number;
  waiting: Array<() => void>;
} = { row: null, clock: 0, holdReads: 0, waiting: [] };

vi.mock("@/lib/db/postgres", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("updated_at::text AS updated_at_exact")) {
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
              },
            ]
          : [],
      };
    }
    if (text.includes("INSERT INTO event_cloud_snapshots")) {
      const payloadJson = values[3] as string;
      const unconditional = values[values.length - 2] as boolean;
      const expected = values[values.length - 1] as string | null;
      if (!unconditional && table.row && table.row.updated_at_exact !== expected) {
        return { rows: [] };
      }
      table.clock += 1000;
      const now = new Date(Date.UTC(2026, 9, 18, 4, 0, 0) + table.clock);
      table.row = {
        payload: payloadJson,
        updated_at: now,
        updated_at_exact: `${now.toISOString()}+123us`,
      };
      return { rows: [{ updated_at: now }] };
    }
    if (text.includes("SELECT updated_at")) {
      return table.row ? { rows: [{ updated_at: table.row.updated_at }] } : { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  }),
}));

import { POST } from "./route";

const SYNC_ID = "aaaaaaaa-bbbb-1ccc-9ddd-eeeeeeeeeeee";

function snap(sales: string[]) {
  return { exportVersion: 6, event: { syncId: SYNC_ID }, sales };
}

function save(
  payload: object,
  extra: { baseUpdatedAt?: string | null; force?: boolean; clientExportedAt?: string } = {}
) {
  return POST(
    new Request("http://localhost/api/sync/push/", {
      method: "POST",
      body: JSON.stringify({
        eventSyncId: SYNC_ID,
        payload,
        clientExportedAt: "2026-10-18T05:00:00.000Z",
        ...extra,
      }),
    })
  );
}

async function updatedAt(res: Response): Promise<string> {
  return ((await res.json()) as { updatedAt: string }).updatedAt;
}

describe("POST /api/sync/push", () => {
  beforeEach(() => {
    table.row = null;
    table.clock = 0;
    table.holdReads = 0;
    table.waiting = [];
  });

  it("first save with no row stored succeeds", async () => {
    const res = await save(snap(["x"]), { baseUpdatedAt: null });
    expect(res.status).toBe(200);
    expect(JSON.parse(table.row!.payload)).toEqual(snap(["x"]));
  });

  it("a save from a stale base is refused and leaves the cloud copy alone", async () => {
    // B saves sale X; A saves from the version before B's, without X.
    const first = await updatedAt(await save(snap([]), { baseUpdatedAt: null }));
    await save(snap(["X"]), { baseUpdatedAt: first });
    const res = await save(snap(["Y"]), { baseUpdatedAt: first });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("sync_conflict");
    expect(JSON.parse(table.row!.payload)).toEqual(snap(["X"]));
  });

  it("a save from the current base succeeds", async () => {
    const first = await updatedAt(await save(snap([]), { baseUpdatedAt: null }));
    const res = await save(snap(["X"]), { baseUpdatedAt: first });
    expect(res.status).toBe(200);
    expect(JSON.parse(table.row!.payload)).toEqual(snap(["X"]));
  });

  it("a save with no base while a row exists is refused", async () => {
    await save(snap([]), { baseUpdatedAt: null });
    const res = await save(snap(["X"]), { baseUpdatedAt: null });
    expect(res.status).toBe(409);
  });

  it("an identical payload is unchanged even from a stale base", async () => {
    const first = await updatedAt(await save(snap(["X"]), { baseUpdatedAt: null }));
    const res = await save(snap(["X"]), { baseUpdatedAt: "2026-10-01T00:00:00.000Z" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unchanged?: boolean; updatedAt: string };
    expect(body.unchanged).toBe(true);
    expect(body.updatedAt).toBe(first);
  });

  it("two saves from the same base: one 200, one 409", async () => {
    const base = await updatedAt(await save(snap([]), { baseUpdatedAt: null }));
    table.holdReads = 2;
    const [a, b] = await Promise.all([
      save(snap(["A"]), { baseUpdatedAt: base }),
      save(snap(["B"]), { baseUpdatedAt: base }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? snap(["A"]) : snap(["B"]);
    expect(JSON.parse(table.row!.payload)).toEqual(winner);
  });

  it("two first saves with no row: the second does not overwrite the first", async () => {
    table.holdReads = 2;
    const [a, b] = await Promise.all([
      save(snap(["A"]), { baseUpdatedAt: null }),
      save(snap(["B"]), { baseUpdatedAt: null }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? snap(["A"]) : snap(["B"]);
    expect(JSON.parse(table.row!.payload)).toEqual(winner);
  });

  it("an older app that sends no base is checked by clock, as before", async () => {
    await save(snap([]), { baseUpdatedAt: null });
    const stale = await save(snap(["X"]), {
      clientExportedAt: "2026-10-18T03:00:00.000Z",
    });
    expect(stale.status).toBe(409);
    const fresh = await save(snap(["X"]), {
      clientExportedAt: "2026-10-18T09:00:00.000Z",
    });
    expect(fresh.status).toBe(200);
    expect(JSON.parse(table.row!.payload)).toEqual(snap(["X"]));
  });

  it("a forced save overwrites even from a stale base", async () => {
    await save(snap(["X"]), { baseUpdatedAt: null });
    const res = await save(snap(["Y"]), {
      baseUpdatedAt: "2026-10-01T00:00:00.000Z",
      force: true,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(table.row!.payload)).toEqual(snap(["Y"]));
  });
});
