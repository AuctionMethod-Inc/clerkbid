import type { AuctionDB } from "@/lib/db";
import { ensureSettingsRow, markDirectoryDirty } from "@/lib/settings";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";
import {
  consolidateDirectoryDuplicates,
  findEventBidderByMaster,
  findEventConsignorByMaster,
  findOrCreateMasterBidder,
  findOrCreateMasterConsignor,
} from "@/lib/directory/upsert";

/**
 * One-time: build master lists from existing event bidders/consignors.
 * Matches email, else phone digits; does not merge name-only duplicates.
 * Event rows get `masterSyncKey` without bumping event `updatedAt` (sync apply guard).
 * Also consolidates any existing email duplicates (including from prior sync).
 */
export async function seedDirectoryFromEvents(db: AuctionDB): Promise<void> {
  await ensureSettingsRow(db);
  const settings = await db.settings.get(1);
  if (settings?.directorySeededAt) {
    // Deduping + cloud push happens via cleanupDirectoryDuplicates after seed.
    return;
  }

  await withCloudSyncApply(async () => {
    const bidders = await db.bidders.toArray();
    for (const b of bidders) {
      if (b.masterSyncKey) continue;
      const master = await findOrCreateMasterBidder(db, {
        firstName: b.firstName,
        lastName: b.lastName,
        phone: b.phone,
        email: b.email,
        mailingAddress: b.mailingAddress,
        resaleNumber: b.resaleNumber,
      }, b.createdAt);
      if (b.id != null) {
        const taken = await findEventBidderByMaster(
          db,
          b.eventId,
          master.syncKey
        );
        if (!taken || taken.id === b.id) {
          await db.bidders.update(b.id, { masterSyncKey: master.syncKey });
        }
      }
    }

    const consignors = await db.consignors.toArray();
    for (const c of consignors) {
      if (c.masterSyncKey) continue;
      const master = await findOrCreateMasterConsignor(db, {
        name: c.name,
        email: c.email,
        phone: c.phone,
        mailingAddress: c.mailingAddress,
        notes: c.notes,
        commissionRate: c.commissionRate,
      }, c.createdAt);
      if (c.id != null) {
        const taken = await findEventConsignorByMaster(
          db,
          c.eventId,
          master.syncKey
        );
        if (!taken || taken.id === c.id) {
          await db.consignors.update(c.id, { masterSyncKey: master.syncKey });
        }
      }
    }

    await consolidateDirectoryDuplicates(db);
  });

  await db.settings.update(1, { directorySeededAt: new Date() });
  await markDirectoryDirty(db);

  const now = new Date();
  const events = await db.events.toArray();
  for (const ev of events) {
    if (ev.id != null) {
      await db.events.update(ev.id, { updatedAt: now });
    }
  }
}
