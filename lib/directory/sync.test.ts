import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import { ensureSettingsRow, markDirectoryDirty } from "@/lib/settings";
import { DIRECTORY_EXPORT_VERSION } from "@/lib/directory/payload";
import {
  publishDirectoryChanges,
  pullDirectoryFromCloud,
  pushDirectoryToCloud,
  syncDirectoryWithCloud,
} from "@/lib/directory/sync";

let db: AuctionDB;

beforeEach(async () => {
  const uid = `dirsync_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  db = new AuctionDB(uid);
  await ensureSettingsRow(db);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  vi.unstubAllGlobals();
  db.close();
  await Dexie.delete(db.name);
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("pushDirectoryToCloud dirty gate", () => {
  it("does not push when directory is not dirty", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    await db.settings.update(1, {
      directoryDirty: false,
      lastDirectoryServerUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const result = await pushDirectoryToCloud(db);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.unchanged).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pushes when dirty and accepts matching base", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      jsonResponse({ ok: true, updatedAt: "2026-01-02T00:00:00.000Z" })
    );
    await db.masterBidders.add({
      syncKey: "a",
      firstName: "A",
      lastName: "B",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.settings.update(1, {
      directoryDirty: true,
      lastDirectoryServerUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const result = await pushDirectoryToCloud(db);
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { baseUpdatedAt: string };
    expect(body.baseUpdatedAt).toBe("2026-01-01T00:00:00.000Z");
    const settings = await db.settings.get(1);
    expect(settings?.directoryDirty).toBe(false);
  });

  it("on 409 replaces local from server payload", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: "stale_base",
          updatedAt: "2026-03-01T00:00:00.000Z",
          payload: {
            exportVersion: DIRECTORY_EXPORT_VERSION,
            exportDate: "2026-03-01T00:00:00.000Z",
            bidders: [
              {
                syncKey: "cloud-only",
                firstName: "Cloud",
                lastName: "Person",
                mailingAddress: "Cloud St",
                createdAt: "2026-03-01T00:00:00.000Z",
                updatedAt: "2026-03-01T00:00:00.000Z",
              },
            ],
            consignors: [],
          },
        },
        409
      )
    );
    await db.masterBidders.add({
      syncKey: "local-orphan",
      firstName: "Local",
      lastName: "Orphan",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await markDirectoryDirty(db);
    await db.settings.update(1, {
      lastDirectoryServerUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await pushDirectoryToCloud(db, { force: true });
    expect(result.ok).toBe(false);
    expect(result.conflictReplaced).toBe(true);
    const masters = await db.masterBidders.toArray();
    expect(masters).toHaveLength(1);
    expect(masters[0]?.syncKey).toBe("cloud-only");
    expect(masters[0]?.mailingAddress).toBe("Cloud St");
    const settings = await db.settings.get(1);
    expect(settings?.directoryDirty).toBe(false);
  });
});

describe("syncDirectoryWithCloud", () => {
  it("replaces local when remote is newer and does not push if not dirty", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(
      jsonResponse({
        payload: {
          exportVersion: DIRECTORY_EXPORT_VERSION,
          exportDate: "2026-04-01T00:00:00.000Z",
          bidders: [
            {
              syncKey: "remote",
              firstName: "Remote",
              lastName: "Clean",
              createdAt: "2026-04-01T00:00:00.000Z",
              updatedAt: "2026-04-01T00:00:00.000Z",
            },
          ],
          consignors: [],
        },
        updatedAt: "2026-04-01T00:00:00.000Z",
      })
    );
    await db.masterBidders.add({
      syncKey: "stale-local",
      firstName: "Stale",
      lastName: "Local",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.settings.update(1, {
      directoryDirty: false,
      lastDirectoryServerUpdatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const result = await syncDirectoryWithCloud(db);
    expect(result.replaced).toBe(true);
    expect(result.pushed).toBe(false);
    expect(await db.masterBidders.count()).toBe(1);
    expect((await db.masterBidders.toArray())[0]?.syncKey).toBe("remote");
    // Only GET, no POST
    expect(
      fetchMock.mock.calls.every(
        (c) => (c[1] as RequestInit | undefined)?.method !== "POST"
      )
    ).toBe(true);
  });
});

const SERVER_AT = "2026-04-01T00:00:00.000Z";
const BASE_AT = new Date("2026-01-01T00:00:00.000Z");

function serverBidder(syncKey: string, firstName: string, updatedAt = SERVER_AT) {
  return {
    syncKey,
    firstName,
    lastName: "Server",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

/** GET returns the server copy; POST records its body and accepts. */
function mockServer(bidders: ReturnType<typeof serverBidder>[]) {
  const posts: Array<{
    payload: { bidders: Array<{ syncKey: string; firstName: string }> };
    baseUpdatedAt: string | null;
  }> = [];
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return jsonResponse({ ok: true, updatedAt: "2026-04-02T00:00:00.000Z" });
    }
    return jsonResponse({
      payload: {
        exportVersion: DIRECTORY_EXPORT_VERSION,
        exportDate: SERVER_AT,
        bidders,
        consignors: [],
      },
      updatedAt: SERVER_AT,
    });
  });
  return { posts, fetchMock };
}

async function addLocalBidder(
  syncKey: string,
  firstName: string,
  updatedAt = new Date("2026-02-01T00:00:00.000Z")
) {
  await db.masterBidders.add({
    syncKey,
    firstName,
    lastName: "Local",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt,
  });
}

async function makeDirty() {
  await db.settings.update(1, {
    directoryDirty: true,
    lastDirectoryServerUpdatedAt: BASE_AT,
  });
}

describe("unpushed local edits when the server copy is newer", () => {
  it("sync merges, keeps local-only people and their event links, and pushes the union", async () => {
    const { posts } = mockServer([serverBidder("server-only", "Sam")]);
    await addLocalBidder("local-only", "Lou");
    await db.bidders.add({
      eventId: 1,
      firstName: "Lou",
      lastName: "Local",
      masterSyncKey: "local-only",
    } as never);
    await makeDirty();

    const result = await syncDirectoryWithCloud(db);

    expect(result.merged).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.pushed).toBe(true);
    const keys = (await db.masterBidders.toArray()).map((b) => b.syncKey).sort();
    expect(keys).toEqual(["local-only", "server-only"]);
    expect((await db.bidders.toArray())[0]?.masterSyncKey).toBe("local-only");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.payload.bidders.map((b) => b.syncKey).sort()).toEqual([
      "local-only",
      "server-only",
    ]);
    expect(posts[0]!.baseUpdatedAt).toBe(SERVER_AT);
    expect((await db.settings.get(1))?.directoryDirty).toBe(false);
  });

  it("pull merges and leaves the Directory unsaved, without pushing", async () => {
    const { fetchMock } = mockServer([serverBidder("server-only", "Sam")]);
    await addLocalBidder("local-only", "Lou");
    await makeDirty();

    const result = await pullDirectoryFromCloud(db);

    expect(result).toEqual({ ok: true, replaced: false, merged: true });
    expect(await db.masterBidders.count()).toBe(2);
    const settings = await db.settings.get(1);
    expect(settings?.directoryDirty).toBe(true);
    expect(settings?.lastDirectoryServerUpdatedAt?.toISOString()).toBe(SERVER_AT);
    expect(
      fetchMock.mock.calls.every(
        (c) => (c[1] as RequestInit | undefined)?.method !== "POST"
      )
    ).toBe(true);
  });

  it("pull still replaces when this device has no unpushed edits", async () => {
    mockServer([serverBidder("server-only", "Sam")]);
    await addLocalBidder("deleted-on-server", "Gone");
    await db.settings.update(1, {
      directoryDirty: false,
      lastDirectoryServerUpdatedAt: BASE_AT,
    });

    const result = await pullDirectoryFromCloud(db);

    expect(result).toEqual({ ok: true, replaced: true, merged: false });
    expect((await db.masterBidders.toArray()).map((b) => b.syncKey)).toEqual([
      "server-only",
    ]);
  });

  it("for a person on both sides the newer copy wins, and this device wins a tie", async () => {
    mockServer([
      serverBidder("newer-on-server", "ServerWins", "2026-03-01T00:00:00.000Z"),
      serverBidder("older-on-server", "ServerLoses", "2026-01-15T00:00:00.000Z"),
      serverBidder("tie", "ServerTie", "2026-02-01T00:00:00.000Z"),
    ]);
    await addLocalBidder("newer-on-server", "LocalLoses");
    await addLocalBidder("older-on-server", "LocalWins");
    await addLocalBidder("tie", "LocalTie");
    await makeDirty();

    await pullDirectoryFromCloud(db);

    const byKey = new Map(
      (await db.masterBidders.toArray()).map((b) => [b.syncKey, b.firstName])
    );
    expect(byKey.get("newer-on-server")).toBe("ServerWins");
    expect(byKey.get("older-on-server")).toBe("LocalWins");
    expect(byKey.get("tie")).toBe("LocalTie");
    expect(byKey.size).toBe(3);
  });
});

describe("publishDirectoryChanges", () => {
  it("pulls and merges before pushing, so the push base is the current server copy", async () => {
    const { posts, fetchMock } = mockServer([serverBidder("server-only", "Sam")]);
    await addLocalBidder("local-only", "Lou");
    await db.settings.update(1, {
      directoryDirty: false,
      lastDirectoryServerUpdatedAt: BASE_AT,
    });

    const result = await publishDirectoryChanges(db);

    expect(result.ok).toBe(true);
    const methods = fetchMock.mock.calls.map(
      (c) => (c[1] as RequestInit | undefined)?.method ?? "GET"
    );
    expect(methods).toEqual(["GET", "POST"]);
    expect(posts[0]!.baseUpdatedAt).toBe(SERVER_AT);
    expect(posts[0]!.payload.bidders.map((b) => b.syncKey).sort()).toEqual([
      "local-only",
      "server-only",
    ]);
  });

  it("a person deleted here stays deleted through the pre-push merge, other additions are kept", async () => {
    const { posts } = mockServer([
      serverBidder("deleted-here", "Del"),
      serverBidder("server-only", "Sam"),
    ]);
    await db.settings.update(1, {
      directoryDirty: false,
      lastDirectoryServerUpdatedAt: BASE_AT,
    });

    const result = await publishDirectoryChanges(db, {
      bidders: ["deleted-here"],
    });

    expect(result.ok).toBe(true);
    expect((await db.masterBidders.toArray()).map((b) => b.syncKey)).toEqual([
      "server-only",
    ]);
    expect(posts[0]!.payload.bidders.map((b) => b.syncKey)).toEqual([
      "server-only",
    ]);
  });

  it("still pushes when the pull fails", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return jsonResponse({ ok: true, updatedAt: "2026-04-02T00:00:00.000Z" });
      }
      throw new TypeError("offline");
    });
    await addLocalBidder("local-only", "Lou");

    const result = await publishDirectoryChanges(db);

    expect(result.ok).toBe(true);
    expect(await db.masterBidders.count()).toBe(1);
  });
});
