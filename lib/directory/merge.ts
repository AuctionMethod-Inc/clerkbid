import type { AuctionDB } from "@/lib/db";
import {
  parseDirectoryDate,
  type DirectoryExportPayload,
} from "@/lib/directory/payload";
import { consolidateDirectoryDuplicates } from "@/lib/directory/upsert";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";

/**
 * Replace local master Directory with a remote vendor snapshot.
 * Clears masters first so deletes on the server stay deleted locally.
 * Clears event masterSyncKey links that no longer exist after replace.
 */
export async function replaceDirectorySnapshot(
  db: AuctionDB,
  remote: DirectoryExportPayload
): Promise<{ bidderCount: number; consignorCount: number }> {
  const keepBidderKeys = new Set(remote.bidders.map((b) => b.syncKey));
  const keepConsignorKeys = new Set(remote.consignors.map((c) => c.syncKey));

  await withCloudSyncApply(async () => {
    await db.transaction(
      "rw",
      [db.masterBidders, db.masterConsignors, db.bidders, db.consignors],
      async () => {
        await db.masterBidders.clear();
        await db.masterConsignors.clear();

        for (let i = 0; i < remote.bidders.length; i++) {
          const rb = remote.bidders[i]!;
          await db.masterBidders.add({
            syncKey: rb.syncKey,
            firstName: rb.firstName,
            lastName: rb.lastName,
            phone: rb.phone,
            email: rb.email,
            mailingAddress: rb.mailingAddress,
            resaleNumber: rb.resaleNumber,
            createdAt: parseDirectoryDate(rb.createdAt),
            updatedAt: parseDirectoryDate(rb.updatedAt),
          });
        }

        for (let i = 0; i < remote.consignors.length; i++) {
          const rc = remote.consignors[i]!;
          await db.masterConsignors.add({
            syncKey: rc.syncKey,
            name: rc.name,
            email: rc.email,
            phone: rc.phone,
            mailingAddress: rc.mailingAddress,
            notes: rc.notes,
            commissionRate: rc.commissionRate,
            createdAt: parseDirectoryDate(rc.createdAt),
            updatedAt: parseDirectoryDate(rc.updatedAt),
          });
        }

        const eventBidders = await db.bidders.toArray();
        for (let i = 0; i < eventBidders.length; i++) {
          const b = eventBidders[i]!;
          if (
            b.id != null &&
            b.masterSyncKey &&
            !keepBidderKeys.has(b.masterSyncKey)
          ) {
            await db.bidders
              .where("id")
              .equals(b.id)
              .modify((row) => {
                delete row.masterSyncKey;
              });
          }
        }

        const eventConsignors = await db.consignors.toArray();
        for (let i = 0; i < eventConsignors.length; i++) {
          const c = eventConsignors[i]!;
          if (
            c.id != null &&
            c.masterSyncKey &&
            !keepConsignorKeys.has(c.masterSyncKey)
          ) {
            await db.consignors
              .where("id")
              .equals(c.id)
              .modify((row) => {
                delete row.masterSyncKey;
              });
          }
        }
      }
    );

    await consolidateDirectoryDuplicates(db);
  });

  return {
    bidderCount: remote.bidders.length,
    consignorCount: remote.consignors.length,
  };
}

/**
 * @deprecated Prefer replaceDirectorySnapshot for cloud pull.
 * Delegates to replace so callers cannot resurrect deletes via union-merge.
 */
export async function mergeDirectorySnapshot(
  db: AuctionDB,
  remote: DirectoryExportPayload
): Promise<{
  biddersAdded: number;
  biddersUpdated: number;
  consignorsAdded: number;
  consignorsUpdated: number;
}> {
  await replaceDirectorySnapshot(db, remote);
  return {
    biddersAdded: remote.bidders.length,
    biddersUpdated: 0,
    consignorsAdded: remote.consignors.length,
    consignorsUpdated: 0,
  };
}
