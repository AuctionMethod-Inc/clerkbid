import { describe, expect, it } from "vitest";
import { validateFeedbackBody } from "./validate";

const good = {
  name: "Pat",
  email: "Pat@Example.com",
  message: "Invoices show the wrong premium for suffixed lots.",
};

describe("validateFeedbackBody", () => {
  it("accepts a minimal valid body and normalizes email", () => {
    const r = validateFeedbackBody(good);
    expect(r.ok).toBe(true);
    if (!r.ok || r.honeypot) throw new Error("expected value");
    expect(r.value.email).toBe("pat@example.com");
    expect(r.value.kind).toBe("other");
    expect(r.value.steps).toBeNull();
    expect(r.value.context.online).toBeNull();
  });

  it("treats a filled honeypot as a silent success", () => {
    const r = validateFeedbackBody({ ...good, website: "http://spam" });
    expect(r).toEqual({ ok: true, honeypot: true });
  });

  it("rejects bad email, short message, long message, long name", () => {
    expect(validateFeedbackBody({ ...good, email: "nope" }).ok).toBe(false);
    expect(validateFeedbackBody({ ...good, email: "a@b" }).ok).toBe(false);
    expect(validateFeedbackBody({ ...good, email: "a@b..c" }).ok).toBe(false);
    expect(validateFeedbackBody({ ...good, email: "a@b.co.uk" }).ok).toBe(true);
    expect(validateFeedbackBody({ ...good, email: "!@!." + "!.".repeat(200) }).ok).toBe(false);
    expect(validateFeedbackBody({ ...good, message: "short" }).ok).toBe(false);
    expect(
      validateFeedbackBody({ ...good, message: "x".repeat(8001) }).ok
    ).toBe(false);
    expect(validateFeedbackBody({ ...good, name: "n".repeat(121) }).ok).toBe(
      false
    );
  });

  it("falls back to kind 'other' for unknown kinds", () => {
    const r = validateFeedbackBody({ ...good, kind: "complaint" });
    if (!r.ok || r.honeypot) throw new Error("expected value");
    expect(r.value.kind).toBe("other");
  });

  it("keeps a valid kind and trimmed steps", () => {
    const r = validateFeedbackBody({
      ...good,
      kind: "bug",
      steps: "  Opened invoice 12A  ",
    });
    if (!r.ok || r.honeypot) throw new Error("expected value");
    expect(r.value.kind).toBe("bug");
    expect(r.value.steps).toBe("Opened invoice 12A");
  });

  it("validates optional context loosely", () => {
    const r = validateFeedbackBody({
      ...good,
      context: {
        pagePath: "/invoices/",
        appVersion: "0.1.0",
        eventSyncId: "not-a-uuid",
        online: false,
      },
    });
    if (!r.ok || r.honeypot) throw new Error("expected value");
    expect(r.value.context).toEqual({
      pagePath: "/invoices/",
      appVersion: "0.1.0",
      eventSyncId: null,
      online: false,
    });
  });

  it("rejects non-object bodies", () => {
    expect(validateFeedbackBody(null).ok).toBe(false);
    expect(validateFeedbackBody("x").ok).toBe(false);
  });
});
