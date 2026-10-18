import type { AuctionDB } from "@/lib/db";
import {
  parseDirectoryDate,
  type DirectoryExportPayload,
} from "@/lib/directory/payload";
import { consolidateDirectoryDuplicates } from "@/lib/directory/upsert";
import { withCloudSyncApply } from "@/lib/db/syncApplyGuard";
import { dateGetTime } from "@/lib/utils/coerceDate";

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
 * Union-merge a remote vendor snapshot into the local Directory, for a device
 * with unpushed edits. People only here stay (with their event links), people
 * only on the server are added, and for a person on both sides the newer
 * `updatedAt` wins (local on a tie). Nothing is deleted, so the caller keeps
 * the Directory dirty and pushes the result. `skip` lists syncKeys deleted on
 * this device that must not be re-added from the server copy.
 */
export type DirectoryDeletedKeys = {
  bidders?: readonly string[];
  consignors?: readonly string[];
};

export async function unionMergeDirectorySnapshot(
  db: AuctionDB,
  remote: DirectoryExportPayload,
  skip?: DirectoryDeletedKeys
): Promise<{
  biddersAdded: number;
  biddersUpdated: number;
  consignorsAdded: number;
  consignorsUpdated: number;
}> {
  const skipBidders = new Set(skip?.bidders);
  const skipConsignors = new Set(skip?.consignors);
  const out = {
    biddersAdded: 0,
    biddersUpdated: 0,
    consignorsAdded: 0,
    consignorsUpdated: 0,
  };

  await withCloudSyncApply(async () => {
    await db.transaction("rw", [db.masterBidders, db.masterConsignors], async () => {
      const localBidders = new Map(
        (await db.masterBidders.toArray()).map((b) => [b.syncKey, b])
      );
      for (const rb of remote.bidders) {
        if (skipBidders.has(rb.syncKey)) continue;
        const row = {
          syncKey: rb.syncKey,
          firstName: rb.firstName,
          lastName: rb.lastName,
          phone: rb.phone,
          email: rb.email,
          mailingAddress: rb.mailingAddress,
          resaleNumber: rb.resaleNumber,
          createdAt: parseDirectoryDate(rb.createdAt),
          updatedAt: parseDirectoryDate(rb.updatedAt),
        };
        const local = localBidders.get(rb.syncKey);
        if (!local) {
          await db.masterBidders.add(row);
          out.biddersAdded++;
        } else if (row.updatedAt.getTime() > (dateGetTime(local.updatedAt) ?? 0)) {
          await db.masterBidders.put({ ...row, id: local.id });
          out.biddersUpdated++;
        }
      }

      const localConsignors = new Map(
        (await db.masterConsignors.toArray()).map((c) => [c.syncKey, c])
      );
      for (const rc of remote.consignors) {
        if (skipConsignors.has(rc.syncKey)) continue;
        const row = {
          syncKey: rc.syncKey,
          name: rc.name,
          email: rc.email,
          phone: rc.phone,
          mailingAddress: rc.mailingAddress,
          notes: rc.notes,
          commissionRate: rc.commissionRate,
          createdAt: parseDirectoryDate(rc.createdAt),
          updatedAt: parseDirectoryDate(rc.updatedAt),
        };
        const local = localConsignors.get(rc.syncKey);
        if (!local) {
          await db.masterConsignors.add(row);
          out.consignorsAdded++;
        } else if (row.updatedAt.getTime() > (dateGetTime(local.updatedAt) ?? 0)) {
          await db.masterConsignors.put({ ...row, id: local.id });
          out.consignorsUpdated++;
        }
      }
    });

    await consolidateDirectoryDuplicates(db);
  });

  return out;
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
