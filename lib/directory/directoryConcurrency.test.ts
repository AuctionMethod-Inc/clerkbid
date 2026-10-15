import { describe, expect, it } from "vitest";

/**
 * Mirrors optimistic concurrency rules in app/api/sync/directory/route.ts
 * so we can unit-test without spinning up Next auth/postgres.
 */
function shouldRejectStaleBase(
  serverUpdatedAt: Date | null,
  baseUpdatedAt: string | null | undefined,
  samePayload: boolean,
  skewMs = 2000
): "ok" | "unchanged" | "stale" {
  if (!serverUpdatedAt) return "ok";
  if (samePayload) return "unchanged";
  const serverMs = serverUpdatedAt.getTime();
  const baseRaw = baseUpdatedAt;
  const baseMs =
    baseRaw != null && baseRaw !== "" ? new Date(baseRaw).getTime() : NaN;
  const baseMissing = baseRaw == null || baseRaw === "";
  const baseStale = !Number.isFinite(baseMs) || serverMs > baseMs + skewMs;
  if (baseMissing || baseStale) return "stale";
  return "ok";
}

describe("directory POST stale base policy", () => {
  const server = new Date("2026-02-01T00:00:00.000Z");

  it("allows insert when no server snapshot", () => {
    expect(shouldRejectStaleBase(null, null, false)).toBe("ok");
  });

  it("rejects missing base when snapshot exists and payload differs", () => {
    expect(shouldRejectStaleBase(server, null, false)).toBe("stale");
    expect(shouldRejectStaleBase(server, undefined, false)).toBe("stale");
  });

  it("allows same payload even with missing/stale base", () => {
    expect(shouldRejectStaleBase(server, null, true)).toBe("unchanged");
    expect(
      shouldRejectStaleBase(server, "2026-01-01T00:00:00.000Z", true)
    ).toBe("unchanged");
  });

  it("rejects base older than server", () => {
    expect(
      shouldRejectStaleBase(server, "2026-01-01T00:00:00.000Z", false)
    ).toBe("stale");
  });

  it("allows base equal to server", () => {
    expect(
      shouldRejectStaleBase(server, "2026-02-01T00:00:00.000Z", false)
    ).toBe("ok");
  });
});
