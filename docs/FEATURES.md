# ClerkBid — Application features

This document summarizes product-facing capabilities of **ClerkBid** (auction clerking PWA). It **does not** describe internal super-admin or impersonation tools.

---

## Platform and architecture

- **Browser-based app** — Runs in modern browsers; no separate desktop installer required for core use.
- **Progressive Web App (PWA)** — Installable from the browser; supports offline-oriented workflows and quick launch from the home screen or dock.
- **Per-account local database** — Auction data for each signed-in user is stored in **IndexedDB** on the device (Dexie), scoped by user id.
- **Multi-tenant by organization** — Each account belongs to an **organization (vendor)** with a name and slug; users are tied to one vendor.
- **Team members (shared cloud)** — Organization **admins** invite additional users (clerk / cashier roles) from Settings; an **email** with a sign-up link is sent when Resend is configured (with a copyable link as fallback). All users in the same vendor share **one cloud backup per event** so multiple devices can stay in sync when online.
- **Multi-event workflow** — Operations are scoped to a **currently selected event**. The sidebar **event switcher** changes context for bidders, consignors, clerking, invoices, and reports. **Directory** is org-wide and does not require an event.
- **Dark and light UI** — Interface supports light/dark/system appearance and related display options (see Accessibility).
- **Vercel Analytics** — Anonymous usage analytics may be collected when deployed on Vercel (project configuration).

---

## Authentication and account

- **Self-serve registration** — Create an account with email, password, name, and organization name; creates vendor + user records server-side (first user is the organization **admin**).
- **Invite-based join** — Admins send a time-limited invite (email plus optional copied link) so teammates register with their own email and password into the same organization (no duplicate vendor).
- **Email + password sign-in** — Credentials-based sessions (JWT), with configurable session lifetime.
- **Forgot password** — Request a reset flow delivered by email (when email is configured).
- **Reset password** — Complete password change via token link from email.
- **Sign out** — Ends the session and returns the user to the **public home page** (not forced to the login screen).
- **Protected app shell** — Authenticated routes require a valid session; middleware redirects unauthenticated users to sign-in (except public routes).

---

## Marketing and public site

- **Landing page** — Product overview, value props (live clerking, invoices/reports, PWA/offline/cloud backup), and calls to action for sign-in or registration.
- **Public legal pages** — User agreement and privacy policy.
- **Public feedback form** — Submit questions or feedback to the team (email delivery when configured).

---

## Dashboard

- **Event-aware home** — Summary and shortcuts for the current event (e.g. sales activity, links into clerking and related areas) using live local data when available.

---

## Events

- **Create and edit events** — Manage auction events as first-class records.
- **Switch active event** — Sidebar switcher; each event maintains its own bidders, consignors, lots, sales, and invoices.
- **Delete event** — Removes associated data for that event (destructive).
- **JSON export** — Export a **single event** as structured JSON for backup or migration.
- **JSON import** — Import an event from JSON (including full-database style payloads where supported).
- **Event-level settings linkage** — Events carry settings used by invoicing and reports (tax, buyer’s premium, currency, organization display name, etc.).

---

## Directory

- **Master lists** — Organization-wide **master bidders** and **master consignors** (search, filter, CSV export), stored locally and synced as a vendor-level cloud snapshot (separate from per-event backups).
- **Lookup to register** — From an event’s Bidders or Consignors page, **Lookup** finds an existing person by name, email, or last 4 digits of phone, then assigns a paddle or consignor number for that auction.
- **Email-unique master, updated on save** — Registering links to a Directory row matched by email (else phone). Saving event bidder/consignor details updates that Directory entry instead of creating a duplicate.
- **Seed** — Existing event registries are copied into Directory once per profile (match email, else phone; name-only rows stay separate).

## Bidders

- **Bidder registry per event** — Paddle number, name, optional phone/email, optional **mailing address**, optional **resale number**, and related data.
- **Manual add and edit** — CRUD-style management in the UI, including **Lookup** from Directory.
- **CSV import** — Bulk import with a documented column template (optional address and resale columns).
- **Deletion rules** — Bidders with recorded sales cannot be deleted (data integrity).

---

## Consignors

- **Consignor registry per event** — Consignor number, name, contact, optional **commission override**. **Lookup** from Directory when adding.
- **Default commission** — Event-level default percentage in Settings; used when a consignor has no override.
- **Manual add and edit** — Full management in the UI.
- **CSV import** — Bulk import consignors.
- **Consignor statements** — Generate **PDF statements** per consignor where implemented.
- **Sale linkage** — Sales recorded on clerking can reference a registered consignor; free-text consignor labels still supported when unlinked.

---

## Lots (catalog)

- **Catalog list** — Per-event table of lot number, description, quantity, status, and consignor display; search supported.
- **CSV import** — Template uses plain headers (`lot`, `description`, optional `suffix`, consignor fields, `quantity`, `notes`); import accepts common synonyms (e.g. Lot number, LOT #, desc, qty). Skips duplicates and unknown consignor numbers.
- **Creation via clerking** — Recording a sale still creates catalog lots when they do not already exist.

---

## Clerking (live sales capture)

- **Sale entry** — Lot number, hammer price, paddle, quantity, description, optional notes, consignor, clerk initials.
- **Keyboard workflow** — **Enter** submits; **Esc** clears the form.
- **Pass-out / split lots** — Optional **Shift+Enter** behavior to create suffix lines (e.g. `12A`, `12B`) when pass-out mode is enabled.
- **Configurable tab order** — Field focus order can be adjusted for different floor workflows.
- **Corrections** — After a sale, use **Recent sales** (below the form), **Lots**, or **Invoices** to edit or void a line; there is no timed undo on the clerk form.
- **Live data** — Tied to the current event’s lots and bidders in local storage.

---

## Invoices

- **Per-bidder invoices** — Each invoice is a separate document with its own number; a bidder can have more than one (for example after new sales post-payment).
- **Sale allocation** — Each sale line is linked to exactly one invoice. Generating or refreshing invoices attaches **unallocated** lines to the current **unpaid** invoice, or creates a **new** unpaid invoice when the bidder only has **paid** invoices and new sales exist.
- **Paid invoices frozen** — Marking an invoice paid does not change its totals; supplemental lines get a new invoice.
- **PDF output** — Open/print invoice PDFs for a single invoice (lines match that invoice only). **Bill To** includes bidder address when present.
- **Resale flag** — Invoice list shows a flag next to paddle when the bidder has a resale number.
- **Payment tracking** — Mark paid or unpaid with payment method and date per invoice.
- **Buyer’s premium and tax** — Defaults come from event settings; **unpaid** invoices can override BP and tax **rates** per invoice.
- **Manual lines** — Unpaid invoices support signed **manual lines** (fees, unrecorded purchases, discounts/credits) applied **after** buyer’s premium and **before** tax; they appear on the PDF and in **accounting CSV** (as `ADJ` rows).

---

## Reports

- **Event summaries** — Total hammer from sales, invoiced buyer’s premium and tax, lot status, bidder totals, payment methods, consignor commission views, and related breakdowns.
- **Bidder totals** — When invoices exist, hammer / buyer’s premium / tax / total per bidder match **invoice** sums; without invoices, BP and tax are estimated from event rates (same basis as invoice generation).
- **Exports** — **Accounting CSV** and consignor-related CSV where available.
- **PDFs** — **Run list** and **bidder list** (and similar) where implemented.

---

## Settings

### Current event

- **Organization display name** — Shown on invoices and reports as configured.
- **Tax rate, buyer’s premium, currency symbol** — Financial defaults for the event.
- **Default consignor commission** — Baseline for consignors without an override.
- **Invoice footer** — Per-event text override (stored locally).
- **Event logo** — Per-event image for invoices (stored locally).

### Account-wide invoice appearance

- **Default logo** — Account-level default for invoice PDFs.
- **Default thank-you line** — With optional `{org}` placeholder for organization name.
- **Scope** — Per-event overrides supersede account defaults for that event.

### Data lifecycle and backup

- **JSON backup** — Download current event or **all events** as export files.
- **Clear event data** — Remove bidders, lots, sales, invoices, etc. for the selected event while keeping the event shell; requires explicit confirmations.
- **Optional cloud backup/sync** — When signed in and enabled, push/pull event snapshots to the server (see Cloud sync).
- **Storage usage** — Approximate browser storage display where the API is available.
- **App metadata** — Version string, install/PWA hints, links to legal pages and feedback.

---

## Cloud sync (optional)

- **Server-side snapshots** — Event payloads stored **per organization (vendor)** and event sync id (JSON matching export shape), shared by every user in that vendor. A separate **vendor directory snapshot** stores the master bidder/consignor list.
- **Idle push** — Unchanged event snapshots do not bump the server timestamp or notify other devices, so invoice lists do not remount when nothing changed.
- **Push** — Upload current event snapshot from the device (with conflict detection vs server timestamp; last write wins at the snapshot level when both sides edit while online).
- **Pull / restore** — Replace local event data from the latest server snapshot when newer.
- **Event list API** — Discover which events have cloud copies and timestamps.
- **Conflict awareness** — UI banner when the server has a newer backup than the last local push; user can restore, push over, or dismiss. Copy explains when **another teammate or device** saved first.
- **Offline awareness** — Sync actions respect online state; messaging covers **fork risk** when devices are offline or isolated. **Practical mitigation at venues:** use Wi‑Fi or a phone **hotspot** so devices share internet and can reach the same cloud backup. A dedicated **LAN sync hub** without the public internet is **not** part of the product today (would be a future add-on).
- **User preferences** — Server-stored flags (e.g. opt-in for **monthly backup email** when cron and email are configured).
- **Cron-based backup email** — Scheduled job (e.g. Vercel Cron) can email opted-in users with snapshot attachments when secrets and email are configured.

---

## Help, support, and product information

- **In-app Help and FAQ** — Markdown guide with table of contents, sections for events, directory, bidders, consignors, clerking, invoices, reports, settings, backups, invoice appearance, feedback, and **open source** notice.
- **Feedback & requests** — Prominent links (sidebar, footer, Help) to the feedback form; emphasizes bug reports and feature requests.
- **Open source** — Help documents MIT license and links to the public **GitHub** repository.
- **Powered-by footer** — Attribution link in the app chrome.

---

## Email (server-side, when configured)

- **Password reset** — Transactional messages for forgot/reset password.
- **Feedback delivery** — Submissions sent to a configurable support inbox (e.g. Resend).
- **Monthly backup mail** — Optional opt-in emails with backup attachments driven by cron (see Cloud sync).

---

## Registration integrations (optional)

When environment variables are set, **new user registration** can trigger a server-side sync to **HubSpot CRM** (find/create company and contact, association, attribution note, and configurable marketing fields). Registration always succeeds even if the integration fails.

---

## Accessibility and display preferences

- **Appearance** — Light, dark, or system color scheme (persisted).
- **Font scale** — Adjustable text sizing (persisted).
- **High contrast** — Optional high-contrast mode (persisted).
- **Help UX** — Skip link and focus-friendly structure on the Help page.

---

## Security and privacy (feature-level)

- **Session secret** — Server-side signing for auth (environment-configured).
- **Password hashing** — Bcrypt for stored password hashes.
- **HTTPS-oriented deployment** — Intended for production TLS (hosting-dependent).
- **Local-only assets** — Invoice logos and some branding blobs are intentionally **not** included in JSON/cloud payloads (documented in Help/FAQ).

---

## Developer and quality

- **TypeScript** — Strongly typed application code.
- **Linting** — ESLint (Next.js config).
- **Unit tests** — Vitest for selected business logic (e.g. CSV parsing, totals, HubSpot email domain helpers).

---

*Last updated to match the application codebase structure; feature availability may depend on hosting configuration (database, email, cron, optional CRM env vars).*
