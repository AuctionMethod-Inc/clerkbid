import "fake-indexeddb/auto";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import Dexie from "dexie";
import { AuctionDB } from "@/lib/db";
import { ensureSettingsRow, markDirectoryDirty } from "@/lib/settings";
import { DIRECTORY_EXPORT_VERSION } from "@/lib/directory/payload";
import {
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
