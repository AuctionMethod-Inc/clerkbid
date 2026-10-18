import * as Sentry from "@sentry/nextjs";
import {
  SENTRY_DATA_COLLECTION,
  SENTRY_IGNORE_ERRORS,
  scrubBreadcrumb,
  scrubEvent,
} from "@/lib/sentry/scrub";

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV,
  // Production deploys only; preview and local builds stay silent.
  enabled: process.env.VERCEL_ENV === "production",
  dataCollection: SENTRY_DATA_COLLECTION,
  tracesSampleRate: 0,
  ignoreErrors: SENTRY_IGNORE_ERRORS,
  beforeSend: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
