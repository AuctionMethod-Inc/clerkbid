import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { SENTRY_IGNORE_ERRORS, scrubEvent } from "./scrub";

describe("scrubEvent", () => {
  it("removes cookies, auth headers, bodies and query strings", () => {
    const event = {
      type: undefined,
      request: {
        url: "https://clerkbid.example/api/sync/",
        cookies: { session: "secret" },
        data: { bidder: "Jane Doe" },
        query_string: "email=jane@example.com",
        headers: { Cookie: "a=b", Authorization: "Bearer x", Accept: "*/*" },
      },
    } as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.request?.cookies).toBeUndefined();
    expect(out.request?.data).toBeUndefined();
    expect(out.request?.query_string).toBeUndefined();
    expect(out.request?.headers).toEqual({ Accept: "*/*" });
  });

  it("keeps only the user id", () => {
    const event = {
      type: undefined,
      user: { id: "42", email: "jane@example.com", ip_address: "1.2.3.4" },
    } as ErrorEvent;
    expect(scrubEvent(event).user).toEqual({ id: "42" });
  });

  it("drops a user with no id", () => {
    const event = {
      type: undefined,
      user: { email: "jane@example.com" },
    } as ErrorEvent;
    expect(scrubEvent(event).user).toBeUndefined();
  });

  it("ignores offline fetch failures", () => {
    expect(SENTRY_IGNORE_ERRORS).toContain("Failed to fetch");
  });
});
