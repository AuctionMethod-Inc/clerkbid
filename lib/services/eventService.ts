import type { AuctionDB } from "@/lib/db";
import { getCurrentEventId, setCurrentEventId } from "@/lib/settings";

/** Removes all bidders, lots, sales, and invoices for the event; keeps the event row. */
export async function clearEventDataKeepShell(
  db: AuctionDB,
  eventId: number
): Promise<void> {
  await db.transaction(
    "rw",
    [
      db.bidders,
      db.consignors,
      db.lots,
      db.sales,
      db.invoices,
      db.eventLocalBranding,
    ],
    async () => {
      await db.bidders.where("eventId").equals(eventId).delete();
      await db.consignors.where("eventId").equals(eventId).delete();
      await db.lots.where("eventId").equals(eventId).delete();
      await db.sales.where("eventId").equals(eventId).delete();
      await db.invoices.where("eventId").equals(eventId).delete();
      await db.eventLocalBranding.where("eventId").equals(eventId).delete();
    }
  );
}

/**
 * Permanently removes the event and all related rows. If the event had a cloud
 * `syncId`, records a tombstone and clears op-sync rows so the next pull cannot
 * resurrect it from the server while the local row is gone.
 */
export async function deleteEventCascade(
  db: AuctionDB,
  eventId: number
): Promise<{ cloudSyncId: string | null }> {
  let cloudSyncId: string | null = null;
  await db.transaction(
    "rw",
    [
      db.bidders,
      db.consignors,
      db.lots,
      db.sales,
      db.invoices,
      db.eventLocalBranding,
      db.syncOutbox,
      db.syncState,
      db.syncConflicts,
      db.deletedCloudSyncTombstones,
      db.cloudBaseSnapshots,
      db.events,
    ],
    async () => {
      const ev = await db.events.get(eventId);
      const sid = ev?.syncId?.trim();
      if (sid) {
        cloudSyncId = sid;
        await db.deletedCloudSyncTombstones.put({
          eventSyncId: sid,
          deletedAt: new Date(),
        });
        await db.syncOutbox.where("eventSyncId").equals(sid).delete();
        await db.syncState.delete(sid);
        await db.syncConflicts.where("eventSyncId").equals(sid).delete();
      }
      await db.bidders.where("eventId").equals(eventId).delete();
      await db.consignors.where("eventId").equals(eventId).delete();
      await db.lots.where("eventId").equals(eventId).delete();
      await db.sales.where("eventId").equals(eventId).delete();
      await db.invoices.where("eventId").equals(eventId).delete();
      await db.eventLocalBranding.where("eventId").equals(eventId).delete();
      await db.cloudBaseSnapshots.delete(eventId);
      await db.events.delete(eventId);
    }
  );
  const current = await getCurrentEventId(db);
  if (current === eventId) {
    await setCurrentEventId(db, null);
  }
  return { cloudSyncId };
}
