import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuctionDB } from "@/lib/db";
import {
  PUSH_BATCH_SIZE,
  pushPendingOpsForEvent,
} from "@/lib/services/opSyncClient";

const SYNC_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

let db: AuctionDB;
let prevFlag: string | undefined;

async function fillOutbox(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.syncOutbox.add({
      eventSyncId: SYNC_ID,
      opId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      opType: "sale.put",
      body: { n: i },
      createdAt: new Date(),
    });
  }
}

type PushBody = { ops: Array<{ opId: string; body: { n: number } }> };

beforeEach(() => {
  prevFlag = process.env.NEXT_PUBLIC_SYNC_OPS;
  process.env.NEXT_PUBLIC_SYNC_OPS = "1";
  db = new AuctionDB(`test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  if (prevFlag === undefined) delete process.env.NEXT_PUBLIC_SYNC_OPS;
  else process.env.NEXT_PUBLIC_SYNC_OPS = prevFlag;
  db.close();
  await Dexie.delete(db.name);
});

describe("pushPendingOpsForEvent", () => {
  it("sends a large outbox in batches the push route accepts, in order", async () => {
    const total = PUSH_BATCH_SIZE * 2 + 50;
    await fillOutbox(total);
    const sent: number[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as PushBody;
        if (body.ops.length > PUSH_BATCH_SIZE) {
          return new Response("{}", { status: 400 });
        }
        sent.push(body.ops.map((o) => o.body.n));
        return Response.json({ acceptedOpIds: body.ops.map((o) => o.opId) });
      })
    );

    const r = await pushPendingOpsForEvent(db, SYNC_ID);

    expect(r).toEqual({ ok: true, status: 200, pushed: total });
    expect(sent.map((b) => b.length)).toEqual([PUSH_BATCH_SIZE, PUSH_BATCH_SIZE, 50]);
    expect(sent.flat()).toEqual(Array.from({ length: total }, (_, i) => i));
    expect(await db.syncOutbox.count()).toBe(0);
  });

  it("stops at the first failed batch and keeps the rest queued", async () => {
    const total = PUSH_BATCH_SIZE + 10;
    await fillOutbox(total);
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls += 1;
        if (calls > 1) return new Response("{}", { status: 500 });
        const body = JSON.parse(String(init.body)) as PushBody;
        return Response.json({ acceptedOpIds: body.ops.map((o) => o.opId) });
      })
    );

    const r = await pushPendingOpsForEvent(db, SYNC_ID);

    expect(r).toEqual({ ok: false, status: 500, pushed: PUSH_BATCH_SIZE });
    expect(calls).toBe(2);
    expect(await db.syncOutbox.count()).toBe(10);
  });
});
