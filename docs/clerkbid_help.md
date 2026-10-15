## Getting started

ClerkBid runs in your browser and stores auction data on **this device** (IndexedDB) for your signed-in account. You need an **internet connection to sign in** and to use cloud backup reliably. If you are **already signed in** and the connection drops, you can **often keep clerking** on that device until you are back online—**do not plan on using ClerkBid entirely offline** (for example opening the app for the first time with no network). Pick an **event** in the sidebar to work with bidders, lots, clerking, invoices, and reports. Switch events anytime; each event has its own catalog and sales.

If you use **cloud backup/sync** (optional, from [Settings](/settings/)), event snapshots are stored on the server **for your whole organization**—everyone who signs in under the same vendor shares the same cloud copies, so clerk and cashier can use different logins and devices. Invoice **logo images** and some branding fields stay **local only** and are not included in JSON export.

**Organization & team** (Settings): an **admin** can send an invitation to a teammate’s email (clerk or cashier role). They receive a sign-up link by email when your site has **Resend** configured (same as password reset); you can also copy the link from Settings if email is not available. Invited people complete sign-up on the join page; they do not create a separate organization.

**Connection loss and multiple devices:** after you have signed in online, a dropped connection on one device usually still lets you work from the local copy on that device until you reconnect. While disconnected, each device keeps its own copy; changes are not visible to teammates until you reconnect and sync. If two devices both change data without syncing in between, you may need **Restore from cloud** or **Overwrite cloud copy** in Settings after reconnect. At a venue with poor connectivity, a **phone hotspot** or local Wi‑Fi with internet often works better than assuming you can coordinate devices with no path to the server.

## Recent updates

Changes since the last major refresh of this Help page:

- **Directory** — [Directory](/directory/) is an org-wide master list of bidders and consignors (search, filter, CSV export, select and delete). Use **Lookup** when registering someone for an event to copy them in and assign a paddle or consignor number. Saving a bidder or consignor on an event also updates their Directory entry (matched by email).
- **Bidders — address and resale** — Optional **address** and **resale number** on each bidder print on invoice PDFs. A flag appears next to the paddle on the invoice list when a resale number is set.
- **Invoices — detail view** — The invoice detail dialog is wider so line items, descriptions, and line totals are easier to read without horizontal scrolling.
- **Invoices — mark as unpaid** — If you marked an invoice paid by mistake, open its detail from [Invoices](/invoices/) and use **Mark as unpaid** (with confirmation). That clears payment method and date and sets the invoice back to unpaid so you can record payment again. Totals and lines on the invoice are unchanged.
- **Reports — buyer’s premium** — The event summary includes **Buyer’s premium (invoiced)**. The **bidder totals** table and its CSV export include a buyer’s premium column; figures follow invoice totals when invoices exist, and otherwise follow the same basis as invoice generation from your event rates.
- **Invoices — correct or remove hammer lines** — On **unpaid** invoices, each clerking line can be **Correct** (edit description, quantity, hammer, paddle/bidder, consignor, initials) or **Remove from invoice** (sale stays on file unallocated; regenerate invoices to attach it again). **Paid** invoices cannot be edited this way—use **Mark as unpaid** first if you must fix totals, then correct and mark paid again.
- **Consignors — mailing address** — Optional **mailing address** on each consignor (and in CSV import) for checks or mail; it appears on **statement PDFs** when filled in.
- **Clerking — edit recent sales** — In **Recent sales**, expand a row and use **Edit sale** to open the same correction form used in invoice detail. This works for unallocated lines too; if the line is already on a paid invoice, mark that invoice unpaid first before editing.

## Events

On [Events](/events/) you can **create** and **edit** events, **switch** the active event, **export** a single event as JSON for backup, and **import** an event from JSON. Export/import is useful for moving data between devices or keeping an offline copy.

Deleting an event removes its bidders, consignors, lots, sales, and invoices for good. The **Directory** master list is not deleted.

## Directory

[Directory](/directory/) holds **master bidders** and **master consignors** for your organization, across every event. Search by first or last name (consignors: any part of the name), email, or the **last 4 digits** of a phone number. Filter (for example has resale number or has email) and **export CSV** of the current view. Select one or many rows and **Delete** to remove them from Directory only (event paddle/consignor registrations stay).

When you **register a bidder** or **add a consignor** on an event, use **Lookup** to find an existing person, then assign a **paddle** or **consignor number** for that auction. That copies their details onto the event. Saving them on the event also updates the master Directory entry for that email.

Existing event registries are copied into Directory the first time you open the app after this feature is enabled.

## Bidders

[Bidders](/bidders/) lists everyone registered for the current event with a **paddle number**. You can add bidders manually, **Lookup** someone from Directory, **import a CSV** (use the template for column names, including optional `mailingAddress` and `resaleNumber`), or edit existing rows. You cannot delete a bidder who already has recorded sales.

Optional **address** prints on the invoice PDF Bill To block. Optional **resale number** shows a flag next to the paddle on the [Invoices](/invoices/) list.

## Consignors and commission

[Consignors](/consignors/) holds a **registry** (consignor number, name, contact, optional **mailing address** for sending checks or mail, optional **commission override**). Use **Lookup** to add someone from the [Directory](/directory/) master list. **Default commission** for the event is set under [Settings](/settings/) (current event). If a consignor has no override, the event default applies; if they do, that percentage is used for their lines on **statements** and **commission reports**.

You can import consignors from CSV (optional `mailingAddress` column, or `address`), add them manually, open a **statement PDF** per consignor (mailing address prints under the name when present), and use [Reports](/reports/) for totals and CSV export. Sales can be **linked** to a registered consignor from the clerking screen; free-text labels still work for display and matching when no link is set.

## Lots (catalog)

[Lots](/lots/) lists catalog lines for the current event (lot number, description, quantity, status, consignor). You can **import lots from CSV** using the on-page template (headers like **lot**, **description**, **suffix**, **consignor**, **consignor number**, **quantity**, **notes**). The importer also recognizes common alternatives—for example **Lot**, **Lot number**, **LOT #** for the lot column, and **desc** or **qty** for description or quantity. A **lot** column and **description** are required; **consignor number** must match a consignor already registered for the event when used. Rows whose lot number already exists in the event are skipped. You can also build the catalog by **recording sales** on [Clerking](/clerking/), which creates lots as needed.

## Clerking

[Clerking](/clerking/) is where you **record sales**: lot number, hammer price, paddle, quantity, description, optional notes and consignor, and clerk initials. **Enter** submits; **Shift+Enter** with pass-out enabled creates suffix lines (e.g. 12A, 12B). **Esc** clears the form. The **consignor** field stays filled between sales (sticky) until you change it or press **Esc**.

Open **Field order (tab sequence) and requirements** on the clerking page to change **Tab** order and which fields must be filled before a sale is accepted. **Lot number** and **description** cannot both be optional (one must stay required for invoicing and reporting); unchecking one turns the other on automatically. If lot number is optional and left blank, the app uses the **suggested next lot** when you submit (you still need a description in that case). **Paddle number** is always required to record a sale. **Pass lot (no sale)** always needs a valid catalog lot number; clerk initials follow your initials requirement setting.

**Recent sales** (below the entry form) lists the latest lines for this event. Expand a row to **Edit sale** (same correction form as on an unpaid invoice: description, quantity, hammer, paddle, consignor, initials) or **Void sale** (removes the sale and marks the lot unsold). Sales not yet on an invoice can still be edited here; if a line is already on a **paid** invoice, mark that invoice unpaid first before editing.

## Invoices

[Invoices](/invoices/) are built **per bidder** for the current event. A bidder can have **several invoice numbers** over time: new sales after an invoice is **paid** are gathered into a **new** unpaid invoice the next time you generate. **Unpaid** invoices are updated when you generate so they include any sales not yet on an invoice. Each **PDF** only includes lines for **that** invoice. For **unpaid** invoices you can optionally override **buyer’s premium** and **tax rates** (otherwise the event defaults from Settings apply), and add **manual lines**—positive amounts for extra charges or unrecorded purchases, negative for discounts or credits. Those lines are calculated **after** buyer’s premium and **before** tax. **Paid** invoices stay fixed; you cannot change their rates or manual lines afterward.

Click a row to open **invoice detail**: a wider layout shows the full line-item table. From there you can print the PDF, **Mark as paid** (unpaid invoices), or **Mark as unpaid** (paid invoices) if you need to reverse a mistaken payment—after confirming, payment method and date are cleared and you can mark paid again.

For **unpaid** invoices only, each **hammer** line (from clerking) has **Correct** and **Remove**. **Correct** opens a form to fix description, quantity, unit hammer, paddle (and thus winning bidder), consignor fields, and clerk initials; totals and PDF update after save. Changing paddle moves the sale to that bidder’s open unpaid invoice the next time invoices are generated or refreshed for them. **Remove** takes the line off this invoice but **does not delete** the underlying sale—it becomes unallocated until you run **Generate / refresh invoices** for the relevant bidder(s). **Paid** invoices do not offer these actions; mark unpaid first if you must adjust hammer lines.

## Reports

[Reports](/reports/) summarizes the event: revenue, lot status, bidder totals, payment methods, **consignor commission** summaries, and exports. The summary includes **buyer’s premium (invoiced)** alongside hammer and tax. **Bidder totals** list hammer, buyer’s premium, tax, and total per bidder (aligned with invoices when they exist). You can download **accounting CSV**, **run list** and **bidder list** PDFs, consignor-related CSV where available, and a **bidder totals CSV** that includes the buyer’s premium column.

## Settings backups and data

[Settings](/settings/) covers **organization name**, **tax rate**, **buyer’s premium**, **currency symbol**, and **default consignor commission** for the **current event**. You can also set **invoice footer** and **event logo** overrides (stored on this device).

The same page includes **JSON backup** (current event or all events), optional **cloud sync**, **clear event data** (keeps the event shell), and app information. Use backups regularly before major changes.

## Invoice appearance

Under Settings, **Invoice appearance** (account-wide) lets you upload a **default logo** and default **thank-you line** for PDF invoices (you can use `{org}` as a placeholder for the organization name). **Per-event** overrides (logo and footer) apply only to that event and override the account defaults. These assets are **not** included in cloud/JSON export.

## Feedback

If something is confusing, broken, or missing, we want to hear it. Use **[Feedback](/feedback/)** (also linked in the sidebar and app footer) to send questions, bug reports, and **requests for changes or new features**. The AuctionMethod team reads every submission and uses it to improve ClerkBid.

## Open source

ClerkBid is published under the **MIT License**, so anyone may use, modify, and redistribute it for commercial or personal projects, subject to the license terms. The full source code is available on **[GitHub](https://github.com/curiousdaniel/clerkbid)**.
