const { withSentryConfig } = require("@sentry/nextjs");
const defaultPwaRuntimeCaching = require("next-pwa/cache");

const withPWA = require("next-pwa")({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
  // Cache `/` on first install (register.js + Workbox) so the installed app can open offline.
  cacheStartUrl: true,
  dynamicStartUrl: true,
  // Cache same-origin navigations from next/link while online for offline clerking.
  cacheOnFrontEndNav: true,
  // When a page was never cached, serve branded HTML instead of the browser error UI.
  fallbacks: {
    document: "/offline.html",
  },
  // Stale-while-revalidate: offline uses last cached shell; online refreshes in background.
  runtimeCaching: [
    {
      urlPattern: ({ request, url }) =>
        request.mode === "navigate" && url.origin === self.origin,
      handler: "StaleWhileRevalidate",
      options: {
        cacheName: "clerkbid-documents",
        expiration: {
          maxEntries: 64,
          maxAgeSeconds: 60 * 60 * 24 * 30,
        },
      },
    },
    ...defaultPwaRuntimeCaching,
  ],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  // Inlined at build time so the browser knows which Vercel environment it is
  // running in (used to enable Sentry on production only).
  env: {
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "",
  },
};

// Source maps upload only for Vercel production builds; preview, CI and local
// builds skip the upload.
module.exports = withSentryConfig(withPWA(nextConfig), {
  org: "auctionmethod",
  project: "sentry-clerkbid",
  authToken:
    process.env.VERCEL_ENV === "production"
      ? process.env.SENTRY_AUTH_TOKEN
      : undefined,
  silent: true,
  widenClientFileUpload: true,
  hideSourceMaps: true,
  disableLogger: true,
});
