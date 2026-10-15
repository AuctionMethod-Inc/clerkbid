/**
 * Pure validation for /api/feedback request bodies. No I/O, so it is unit
 * tested directly.
 */

export const FEEDBACK_KINDS = ["bug", "feature", "question", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_LIMITS = {
  nameMax: 120,
  emailMax: 254,
  messageMin: 10,
  messageMax: 8000,
  stepsMax: 4000,
  pagePathMax: 512,
  appVersionMax: 32,
  userAgentMax: 512,
} as const;

// Disjoint character classes on either side of "." keep matching linear;
// length is checked before the regex runs.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Optional client-side context the in-app entry point attaches. */
export type FeedbackContext = {
  pagePath: string | null;
  appVersion: string | null;
  eventSyncId: string | null;
  online: boolean | null;
};

export type ValidFeedback = {
  name: string;
  email: string;
  message: string;
  kind: FeedbackKind;
  steps: string | null;
  context: FeedbackContext;
};

export type ValidationResult =
  | { ok: true; honeypot: true }
  | { ok: true; honeypot: false; value: ValidFeedback }
  | { ok: false; status: number; error: string };

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clip(v: unknown, max: number): string | null {
  const s = str(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function isFeedbackKind(v: unknown): v is FeedbackKind {
  return (
    typeof v === "string" && (FEEDBACK_KINDS as readonly string[]).includes(v)
  );
}

export function validateFeedbackBody(body: unknown): ValidationResult {
  if (!body || typeof body !== "object") {
    return { ok: false, status: 400, error: "Invalid request." };
  }
  const b = body as Record<string, unknown>;

  // Honeypot: real users never fill this in. Pretend success so bots move on.
  if (str(b.website).trim()) {
    return { ok: true, honeypot: true };
  }

  const email = str(b.email).trim().toLowerCase();
  const message = str(b.message).trim();
  const name = str(b.name).trim();

  if (!email || email.length > FEEDBACK_LIMITS.emailMax || !EMAIL_RE.test(email)) {
    return {
      ok: false,
      status: 400,
      error: "Please enter a valid email address.",
    };
  }

  if (!message || message.length < FEEDBACK_LIMITS.messageMin) {
    return {
      ok: false,
      status: 400,
      error: `Please enter a message (at least ${FEEDBACK_LIMITS.messageMin} characters).`,
    };
  }

  if (message.length > FEEDBACK_LIMITS.messageMax) {
    return {
      ok: false,
      status: 400,
      error: `Message is too long (max ${FEEDBACK_LIMITS.messageMax.toLocaleString()} characters).`,
    };
  }

  if (name.length > FEEDBACK_LIMITS.nameMax) {
    return { ok: false, status: 400, error: "Name is too long." };
  }

  const kind: FeedbackKind = isFeedbackKind(b.kind) ? b.kind : "other";

  const stepsRaw = str(b.steps).trim();
  if (stepsRaw.length > FEEDBACK_LIMITS.stepsMax) {
    return {
      ok: false,
      status: 400,
      error: `“What were you doing” is too long (max ${FEEDBACK_LIMITS.stepsMax.toLocaleString()} characters).`,
    };
  }

  const ctxRaw =
    b.context && typeof b.context === "object"
      ? (b.context as Record<string, unknown>)
      : {};
  const eventSyncId = clip(ctxRaw.eventSyncId, 36);
  const context: FeedbackContext = {
    pagePath: clip(ctxRaw.pagePath, FEEDBACK_LIMITS.pagePathMax),
    appVersion: clip(ctxRaw.appVersion, FEEDBACK_LIMITS.appVersionMax),
    eventSyncId: eventSyncId && UUID_RE.test(eventSyncId) ? eventSyncId : null,
    online: typeof ctxRaw.online === "boolean" ? ctxRaw.online : null,
  };

  return {
    ok: true,
    honeypot: false,
    value: {
      name,
      email,
      message,
      kind,
      steps: stepsRaw || null,
      context,
    },
  };
}
