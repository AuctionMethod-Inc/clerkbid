import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import type { Breadcrumb } from "@sentry/nextjs";
import {
  SENTRY_DATA_COLLECTION,
  SENTRY_IGNORE_ERRORS,
  scrubBreadcrumb,
  scrubEvent,
  stripUrlQuery,
} from "./scrub";

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

  it("strips the reset token from the request url and breadcrumbs", () => {
    const event = {
      type: undefined,
      request: { url: "https://clerkbid.com/reset-password/?token=abc123" },
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: "/login/",
            to: "/register/join/?token=invite456",
          },
        },
        {
          category: "fetch",
          data: {
            url: "/api/auth/reset-password/?token=abc123",
            method: "POST",
            status_code: 500,
          },
        },
      ],
    } as ErrorEvent;
    const out = scrubEvent(event);
    expect(out.request?.url).toBe("https://clerkbid.com/reset-password/");
    expect(out.breadcrumbs?.[0].data).toEqual({
      from: "/login/",
      to: "/register/join/",
    });
    expect(out.breadcrumbs?.[1].data).toEqual({
      url: "/api/auth/reset-password/",
      method: "POST",
      status_code: 500,
    });
    expect(JSON.stringify(out)).not.toMatch(/abc123|invite456/);
  });

  it("scrubs breadcrumbs as they are recorded", () => {
    const crumb: Breadcrumb = {
      category: "xhr",
      data: { url: "https://clerkbid.com/api/x/?token=t#frag" },
    };
    expect(scrubBreadcrumb(crumb).data).toEqual({
      url: "https://clerkbid.com/api/x/",
    });
  });

  it("leaves urls without a query alone", () => {
    expect(stripUrlQuery("/bidders/")).toBe("/bidders/");
    expect(stripUrlQuery("/a/#section")).toBe("/a/");
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

describe("SENTRY_DATA_COLLECTION", () => {
  it("turns off everything Sentry 11 collects by default", () => {
    expect(SENTRY_DATA_COLLECTION).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
    });
  });
});
