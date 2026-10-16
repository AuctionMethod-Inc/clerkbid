import type { ErrorEvent } from "@sentry/nextjs";

/**
 * Shared Sentry options. ClerkBid handles bidder names, addresses and payment
 * details, so events carry stack traces and routes only: no cookies, auth
 * headers, request bodies, or user details beyond an opaque id.
 */

/** Offline is a normal state for this PWA; failed network calls are not bugs. */
export const SENTRY_IGNORE_ERRORS: Array<string | RegExp> = [
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
  /^TypeError: (Failed to fetch|Load failed|NetworkError)/,
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
];

const SENSITIVE_HEADERS = ["cookie", "set-cookie", "authorization"];

export function scrubEvent<T extends ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    if (event.request.headers) {
      for (const name of Object.keys(event.request.headers)) {
        if (SENSITIVE_HEADERS.includes(name.toLowerCase())) {
          delete event.request.headers[name];
        }
      }
    }
  }
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  return event;
}
