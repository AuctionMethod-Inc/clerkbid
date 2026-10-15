import { describe, expect, it } from "vitest";
import { evaluateRateLimit, hashIp, RATE_LIMITS } from "./rateLimit";

describe("evaluateRateLimit", () => {
  it("allows under both limits", () => {
    expect(
      evaluateRateLimit({ ipHash: "h", ipCount: 0, emailCount: 0 }).ok
    ).toBe(true);
    expect(
      evaluateRateLimit({
        ipHash: "h",
        ipCount: RATE_LIMITS.perIpPerHour - 1,
        emailCount: RATE_LIMITS.perEmailPerDay - 1,
      }).ok
    ).toBe(true);
  });

  it("blocks at the ip limit, only when an ip hash exists", () => {
    expect(
      evaluateRateLimit({ ipHash: "h", ipCount: RATE_LIMITS.perIpPerHour, emailCount: 0 }).ok
    ).toBe(false);
    expect(
      evaluateRateLimit({ ipHash: null, ipCount: 99, emailCount: 0 }).ok
    ).toBe(true);
  });

  it("blocks at the email limit", () => {
    const r = evaluateRateLimit({
      ipHash: null,
      ipCount: 0,
      emailCount: RATE_LIMITS.perEmailPerDay,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/email/);
  });
});

describe("hashIp", () => {
  it("is stable and never returns the raw ip", () => {
    const a = hashIp("203.0.113.9");
    expect(a).toHaveLength(64);
    expect(a).toBe(hashIp("203.0.113.9"));
    expect(a).not.toContain("203");
    expect(hashIp(null)).toBeNull();
  });
});
