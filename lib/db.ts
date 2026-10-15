import Dexie, { type Table } from "dexie";
import { registerParentEventTouchHooks } from "@/lib/db/parentEventTouchHooks";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";
import { newEntitySyncKey } from "@/lib/utils/clientSyncKey";
import { newEventSyncId } from "@/lib/utils/syncId";

/** Pre–per-user DB; migrated once into the signed-in user's database. */
export const LEGACY_DB_NAME = "AuctionManagerDB";

const STORE_DEF_CORE = {
  events: "++id, name, createdAt, syncId",
  bidders:
    "++id, eventId, paddleNumber, [eventId+paddleNumber]",
  lots:
    "++id, eventId, baseLotNumber, lotSuffix, displayLotNumber, status, [eventId+displayLotNumber], [eventId+baseLotNumber]",
  sales:
    "++id, eventId, lotId, bidderId, displayLotNumber, paddleNumber",
  invoices: "++id, eventId, bidderId, status, invoiceNumber",
  settings: "++id",
} as const;

const STORE_DEF_V4 = {
  ...STORE_DEF_CORE,
  eventLocalBranding: "++id, &eventId",
} as const;

const STORE_DEF_V5 = {
  ...STORE_DEF_V4,
  consignors:
    "++id, eventId, consignorNumber, [eventId+consignorNumber]",
  lots:
    "++id, eventId, baseLotNumber, lotSuffix, displayLotNumber, status, [eventId+displayLotNumber], [eventId+baseLotNumber], consignorId",
  sales:
    "++id, eventId, lotId, bidderId, displayLotNumber, paddleNumber, consignorId",
} as const;

const STORE_DEF_V6 = {
  ...STORE_DEF_V5,
  sales:
    "++id, eventId, lotId, bidderId, displayLotNumber, paddleNumber, consignorId, invoiceId",
} as const;

const STORE_DEF_V7 = {
  ...STORE_DEF_V6,
} as const;

const STORE_DEF_V8 = {
  ...STORE_DEF_V7,
} as const;

const STORE_DEF_V9 = {
  ...STORE_DEF_V8,
  sales:
    "++id, eventId, lotId, bidderId, displayLotNumber, paddleNumber, consignorId, invoiceId, syncKey",
  invoices:
    "++id, eventId, bidderId, status, invoiceNumber, syncKey",
  syncOutbox: "++id, eventSyncId, opId, createdAt",
  syncState: "&eventSyncId, lastServerOpId",
  syncConflicts: "++id, eventSyncId, dismissedAt",
} as const;

const STORE_DEF_V10 = {
  ...STORE_DEF_V9,
  /** User deleted this cloud sync id locally; do not pull it from the server again. */
  deletedCloudSyncTombstones: "&eventSyncId, deletedAt",
} as const;

const STORE_DEF_V11 = {
  ...STORE_DEF_V10,
  bidders:
    "++id, eventId, paddleNumber, [eventId+paddleNumber], masterSyncKey, [eventId+masterSyncKey]",
  consignors:
    "++id, eventId, consignorNumber, [eventId+consignorNumber], masterSyncKey, [eventId+masterSyncKey]",
  masterBidders: "++id, &syncKey, lastName, email",
  masterConsignors: "++id, &syncKey, name, email",
} as const;

export function sanitizeUserIdForDbName(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function userDexieDatabaseName(userId: string | number): string {
  return `ClerkBid_u_${sanitizeUserIdForDbName(String(userId))}`;
}

export interface AuctionEvent {
  id?: number;
  name: string;
  description?: string;
  organizationName: string;
  taxRate: number;
  /** 0–1, buyer's premium rate on hammer; invoice rows store premium separately. */
  buyersPremiumRate: number;
  /** 0–1, default commission on hammer paid by consignor (before per-consignor override). */
  defaultConsignorCommissionRate: number;
  currencySymbol: string;
  /** Stable id for cloud backup / sync (UUID). */
  syncId: string;
  lastCloudPushAt?: Date;
  lastCloudPullAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface Bidder {
  id?: number;
  eventId: number;
  paddleNumber: number;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  /** Mailing / home address (multiline OK). */
  mailingAddress?: string;
  /** Dealer / resale certificate number when the bidder has one. */
  resaleNumber?: string;
  /** Link to org-wide master bidder (`MasterBidder.syncKey`). */
  masterSyncKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Lot {
  id?: number;
  eventId: number;
  baseLotNumber: number;
  lotSuffix: string;
  displayLotNumber: string;
  description: string;
  consignor?: string;
  /** Optional link to consignors table; commission attribution prefers this. */
  consignorId?: number;
  /** Ring / clerk notes, shown when clerking. */
  notes?: string;
  quantity: number;
  status: "unsold" | "sold" | "passed" | "withdrawn";
  createdAt: Date;
  updatedAt: Date;
}

export interface Sale {
  id?: number;
  eventId: number;
  lotId: number;
  bidderId: number;
  displayLotNumber: string;
  paddleNumber: number;
  description: string;
  consignor?: string;
  consignorId?: number;
  quantity: number;
  /** Hammer line total (unit hammer × quantity). */
  amount: number;
  clerkInitials: string;
  createdAt: Date;
  /** Which invoice owns this line; null/undefined = not yet allocated. */
  invoiceId?: number | null;
  /** Stable id for operation-level sync (UUID). */
  syncKey?: string;
}

/** Manual invoice line (fees, credits, unrecorded purchases); post–buyer's premium, pre-tax. */
export interface InvoiceManualLine {
  id: string;
  description: string;
  /** Signed dollars (negative = discount/credit). */
  amount: number;
}

export interface Invoice {
  id?: number;
  eventId: number;
  bidderId: number;
  invoiceNumber: string;
  /** Sum of hammer / bid line amounts (before buyer's premium). */
  subtotal: number;
  /** Buyer's premium dollars; tax applies to subtotal + buyersPremiumAmount + manual lines. */
  buyersPremiumAmount: number;
  taxAmount: number;
  total: number;
  status: "unpaid" | "paid";
  paymentMethod?: "cash" | "check" | "credit_card" | "other";
  paymentDate?: Date;
  generatedAt: Date;
  /** When set, overrides event buyer's premium rate (0–1) for this invoice. */
  buyersPremiumRate?: number | null;
  /** When set, overrides event tax rate (0–1) for this invoice. */
  taxRate?: number | null;
  /** Adjustments after BP, before tax. */
  manualLines?: InvoiceManualLine[];
  /** Stable id for operation-level sync (UUID). */
  syncKey?: string;
}

/** Pending ops to push to the server op log. */
export interface SyncOutboxRow {
  id?: number;
  eventSyncId: string;
  opId: string;
  opType: string;
  body: unknown;
  createdAt: Date;
}

/** Per-event cursor into the server op log (`event_sync_ops.id`). */
export interface SyncStateRow {
  eventSyncId: string;
  lastServerOpId: string;
  updatedAt: Date;
}

/** Recorded merge/sync conflicts for review in Settings. */
export interface SyncConflictRow {
  id?: number;
  eventSyncId: string;
  opType: string;
  detail: string;
  payload?: unknown;
  createdAt: Date;
  dismissedAt?: Date;
}

/** Local marker: this eventSyncId was permanently deleted; ignore server list until re-import. */
export interface DeletedCloudSyncTombstone {
  eventSyncId: string;
  deletedAt: Date;
}

export interface AppSettings {
  id?: number;
  currentEventId: number | null;
  lastBackupDate?: Date;
  lastCloudPushAt?: Date;
  lastCloudPullAt?: Date;
  lastBackupNudgeDismissedAt?: Date;
  lastDirectoryPushAt?: Date;
  lastDirectoryPullAt?: Date;
  /** Server `updated_at` from last successful Directory pull/push (optimistic concurrency base). */
  lastDirectoryServerUpdatedAt?: Date;
  /** True when local master Directory has unsynced edits/deletes. */
  directoryDirty?: boolean;
  /** Set after one-time seed of master lists from existing event registries. */
  directorySeededAt?: Date;
  /** Local only — not included in JSON/cloud export. */
  invoiceLogoBlob?: Blob;
  invoiceLogoMime?: string;
  /** Default invoice thank-you line; use {org} as placeholder for organization name. */
  invoiceFooterMessage?: string;
}

export interface Consignor {
  id?: number;
  eventId: number;
  /** Unique within the event (like paddle number). */
  consignorNumber: number;
  name: string;
  email?: string;
  phone?: string;
  /** Mailing address for checks or correspondence (multiline OK). */
  mailingAddress?: string;
  notes?: string;
  /** 0–1; when set, overrides event defaultConsignorCommissionRate for this consignor. */
  commissionRate?: number;
  /** Link to org-wide master consignor (`MasterConsignor.syncKey`). */
  masterSyncKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Org-wide bidder directory (not scoped to an event). */
export interface MasterBidder {
  id?: number;
  syncKey: string;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  mailingAddress?: string;
  resaleNumber?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Org-wide consignor directory (not scoped to an event). */
export interface MasterConsignor {
  id?: number;
  syncKey: string;
  name: string;
  email?: string;
  phone?: string;
  mailingAddress?: string;
  notes?: string;
  /** 0–1 default commission copied onto an event consignor when adding from directory. */
  commissionRate?: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Local-only branding for one event (overrides user defaults on invoices). */
export interface EventLocalBranding {
  id?: number;
  eventId: number;
  invoiceLogoBlob?: Blob;
  invoiceLogoMime?: string;
  invoiceFooterMessage?: string;
}

export class AuctionDB extends Dexie {
  events!: Table<AuctionEvent>;
  bidders!: Table<Bidder>;
  consignors!: Table<Consignor>;
  lots!: Table<Lot>;
  sales!: Table<Sale>;
  invoices!: Table<Invoice>;
  settings!: Table<AppSettings>;
  eventLocalBranding!: Table<EventLocalBranding>;
  syncOutbox!: Table<SyncOutboxRow>;
  syncState!: Table<SyncStateRow>;
  syncConflicts!: Table<SyncConflictRow>;
  deletedCloudSyncTombstones!: Table<DeletedCloudSyncTombstone>;
  masterBidders!: Table<MasterBidder>;
  masterConsignors!: Table<MasterConsignor>;

  constructor(userId: string | number) {
    super(userDexieDatabaseName(userId));
    this.version(1).stores({
      events: "++id, name, createdAt",
      bidders:
        "++id, eventId, paddleNumber, [eventId+paddleNumber]",
      lots:
        "++id, eventId, baseLotNumber, lotSuffix, displayLotNumber, status, [eventId+displayLotNumber], [eventId+baseLotNumber]",
      sales:
        "++id, eventId, lotId, bidderId, displayLotNumber, paddleNumber",
      invoices: "++id, eventId, bidderId, status, invoiceNumber",
      settings: "++id",
    });
    this.version(2)
      .stores(STORE_DEF_CORE)
      .upgrade(async (tx) => {
        const evTable = tx.table("events");
        await evTable.toCollection().modify((row: Record<string, unknown>) => {
          if (row.syncId == null || row.syncId === "") {
            row.syncId = newEventSyncId();
          }
          if (row.buyersPremiumRate == null || row.buyersPremiumRate === "") {
            row.buyersPremiumRate = 0;
          }
        });
      });
    this.version(3)
      .stores(STORE_DEF_CORE)
      .upgrade(async (tx) => {
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const events = await tx.table("events").toArray();
        const eventById = new Map<number, Record<string, unknown>>();
        for (const ev of events) {
          const id = ev.id as number | undefined;
          if (id != null) eventById.set(id, ev as Record<string, unknown>);
        }
        await tx
          .table("invoices")
          .toCollection()
          .modify((inv: Invoice) => {
            const row = inv as Invoice & { buyersPremiumAmount?: number };
            if (typeof row.buyersPremiumAmount === "number") return;
            const ev = eventById.get(inv.eventId);
            const bpRateRaw = ev?.buyersPremiumRate;
            const bpRate =
              typeof bpRateRaw === "number" && Number.isFinite(bpRateRaw)
                ? Math.max(0, bpRateRaw)
                : 0;
            const oldTaxable = inv.subtotal;
            const hammer = round2(oldTaxable / (1 + bpRate));
            const bpAmt = round2(oldTaxable - hammer);
            row.subtotal = hammer;
            row.buyersPremiumAmount = bpAmt;
          });
      });
    this.version(4).stores(STORE_DEF_V4);
    this.version(5)
      .stores(STORE_DEF_V5)
      .upgrade(async (tx) => {
        const evTable = tx.table("events");
        await evTable.toCollection().modify((row: Record<string, unknown>) => {
          const v = row.defaultConsignorCommissionRate;
          if (
            v == null ||
            v === "" ||
            (typeof v === "number" && !Number.isFinite(v))
          ) {
            row.defaultConsignorCommissionRate = 0;
          }
        });
      });
    this.version(6)
      .stores(STORE_DEF_V6)
      .upgrade(async (tx) => {
        const salesTable = tx.table("sales");
        const invoices = await tx.table("invoices").toArray();
        const sorted = (invoices as Invoice[]).sort(
          (a, b) => (a.id ?? 0) - (b.id ?? 0)
        );
        for (const inv of sorted) {
          if (inv.id == null) continue;
          const rows = await salesTable
            .where("eventId")
            .equals(inv.eventId)
            .filter(
              (s: Sale) =>
                s.bidderId === inv.bidderId &&
                (s.invoiceId === undefined || s.invoiceId === null)
            )
            .toArray();
          for (const s of rows) {
            if (s.id != null) {
              await salesTable.update(s.id, { invoiceId: inv.id });
            }
          }
        }
      });
    this.version(7).stores(STORE_DEF_V7);
    this.version(8).stores(STORE_DEF_V8);
    this.version(9)
      .stores(STORE_DEF_V9)
      .upgrade(async (tx) => {
        const salesTable = tx.table("sales");
        const invTable = tx.table("invoices");
        await salesTable.toCollection().modify((s: Sale) => {
          if (s.syncKey == null || s.syncKey === "") {
            s.syncKey = newEntitySyncKey();
          }
        });
        await invTable.toCollection().modify((inv: Invoice) => {
          if (inv.syncKey == null || inv.syncKey === "") {
            inv.syncKey = newEntitySyncKey();
          }
        });
      });
    this.version(10).stores(STORE_DEF_V10);
    this.version(11).stores(STORE_DEF_V11);
    registerParentEventTouchHooks(this);
  }
}

const dbInstanceCache = new Map<string, AuctionDB>();

export function getAuctionDB(userId: string | number): AuctionDB {
  const key = String(userId);
  let d = dbInstanceCache.get(key);
  if (!d) {
    d = new AuctionDB(key);
    dbInstanceCache.set(key, d);
  }
  return d;
}

/** Call on sign-out so another account on this device gets a clean open. */
export function closeAndClearAuctionDbCache(): void {
  dbInstanceCache.forEach((d) => {
    d.close();
  });
  dbInstanceCache.clear();
}

/** Split pre–v3 invoice.subtotal (hammer + BP) using each event's BP rate. */
async function normalizeInvoicesMissingBuyersPremium(db: AuctionDB): Promise<void> {
  const events = await db.events.toArray();
  const evMap = new Map<number, AuctionEvent>();
  for (const e of events) {
    if (e.id != null) evMap.set(e.id, e);
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  await db.invoices.toCollection().modify((inv: Invoice) => {
    const row = inv as Invoice & { buyersPremiumAmount?: number };
    if (typeof row.buyersPremiumAmount === "number") return;
    const ev = evMap.get(inv.eventId);
    const bpRateRaw = ev?.buyersPremiumRate;
    const bpRate =
      typeof bpRateRaw === "number" && Number.isFinite(bpRateRaw)
        ? Math.max(0, bpRateRaw)
        : 0;
    const oldTaxable = inv.subtotal;
    const hammer = round2(oldTaxable / (1 + bpRate));
    const bpAmt = round2(oldTaxable - hammer);
    row.subtotal = hammer;
    row.buyersPremiumAmount = bpAmt;
  });
}

/**
 * One-time: copy legacy single-DB data into this user's DB, then delete legacy.
 */
export async function migrateLegacyToUserDb(userDb: AuctionDB): Promise<void> {
  const exists = await Dexie.exists(LEGACY_DB_NAME);
  if (!exists) return;

  if ((await userDb.events.count()) > 0) return;

  const legacy = new Dexie(LEGACY_DB_NAME);
  legacy.version(1).stores({
    events: "++id, name, createdAt",
    bidders:
      "++id, eventId, paddleNumber, [eventId+paddleNumber]",
    lots:
      "++id, eventId, baseLotNumber, lotSuffix, displayLotNumber, status, [eventId+displayLotNumber], [eventId+baseLotNumber]",
    sales:
      "++id, eventId, lotId, bidderId, displayLotNumber, paddleNumber",
    invoices: "++id, eventId, bidderId, status, invoiceNumber",
    settings: "++id",
  });
  try {
    await legacy.open();
  } catch {
    return;
  }

  try {
    if ((await legacy.table("events").count()) === 0) return;

    const tableNames = [
      "events",
      "bidders",
      "lots",
      "sales",
      "invoices",
      "settings",
    ] as const;

    await withCloudSyncApply(async () => {
      await userDb.transaction("rw", userDb.tables, async () => {
        for (const name of tableNames) {
          const rows = await legacy.table(name).toArray();
          if (rows.length === 0) continue;
          if (name === "events") {
            for (const r of rows as Record<string, unknown>[]) {
              if (r.syncId == null || r.syncId === "") {
                r.syncId = newEventSyncId();
              }
              if (r.buyersPremiumRate == null) r.buyersPremiumRate = 0;
              if (r.defaultConsignorCommissionRate == null) {
                r.defaultConsignorCommissionRate = 0;
              }
              await userDb.table(name).add(r as never);
            }
          } else {
            await userDb.table(name).bulkAdd(rows as never[]);
          }
        }
      });

      await normalizeInvoicesMissingBuyersPremium(userDb);
    });

    await legacy.delete();
  } finally {
    legacy.close();
  }
}
