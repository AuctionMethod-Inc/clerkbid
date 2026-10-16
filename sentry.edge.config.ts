import * as Sentry from "@sentry/nextjs";
import { SENTRY_IGNORE_ERRORS, scrubEvent } from "@/lib/sentry/scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  enabled: process.env.NODE_ENV === "production",
  sendDefaultPii: false,
  tracesSampleRate: 0,
  ignoreErrors: SENTRY_IGNORE_ERRORS,
  beforeSend: scrubEvent,
});
