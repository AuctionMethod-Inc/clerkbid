import * as Sentry from "@sentry/nextjs";
import { SENTRY_IGNORE_ERRORS, scrubEvent } from "@/lib/sentry/scrub";

// With no DSN (local dev, CI) the SDK stays inert.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  enabled: process.env.NODE_ENV === "production",
  sendDefaultPii: false,
  tracesSampleRate: 0,
  ignoreErrors: SENTRY_IGNORE_ERRORS,
  beforeSend: scrubEvent,
});
