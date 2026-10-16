import type { Breadcrumb, ErrorEvent } from "@sentry/nextjs";

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

/**
 * Password-reset and org-invite links carry a live `?token=` credential, so
 * every URL leaving the browser or server drops its query and fragment.
 */
export function stripUrlQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** Breadcrumb fields that hold URLs: fetch/xhr `url`, navigation `from`/`to`. */
const BREADCRUMB_URL_KEYS = ["url", "from", "to"];

export function scrubBreadcrumb<T extends Breadcrumb>(breadcrumb: T): T {
  const data = breadcrumb.data;
  if (data) {
    for (const key of BREADCRUMB_URL_KEYS) {
      if (typeof data[key] === "string") data[key] = stripUrlQuery(data[key]);
    }
  }
  return breadcrumb;
}

export function scrubEvent<T extends ErrorEvent>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = stripUrlQuery(event.request.url);
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
  event.breadcrumbs?.forEach(scrubBreadcrumb);
  if (event.user) {
    event.user = event.user.id ? { id: event.user.id } : undefined;
  }
  return event;
}
