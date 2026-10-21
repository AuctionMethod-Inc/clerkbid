import type { AuctionDB, Bidder, MasterBidder } from "@/lib/db";
import { mutateWithEventTables } from "@/lib/db/mutateWithParentEventTouch";
import { digitsOnly, normalizeEmail } from "@/lib/directory/match";
import { findMasterBidder, findOrCreateMasterBidder } from "@/lib/directory/upsert";

export type CopyPaddleMode = "keep" | "renumber";

export type CopyBiddersResult = {
  added: number;
  /**
   * Already registered in the target event: same Directory entry, email, or
   * name + phone; for a bidder with neither email nor phone, same name.
   */
  skipped: number;
  /** "keep" mode only: paddle was taken in the target event, so the bidder got the next free one. */
  renumbered: Array<{ name: string; from: number; to: number }>;
};

function nameKey(b: { firstName: string; lastName: string }): string {
  return `${b.firstName} ${b.lastName}`.trim().toLowerCase().replace(/\s+/g, " ");
}

function phoneNameKey(b: Bidder): string | null {
  const phone = digitsOnly(b.phone);
  return phone.length >= 7 ? `${phone}|${nameKey(b)}` : null;
}

/** Name alone, only for bidders with no email or phone to match on. */
function bareNameKey(b: Bidder): string | null {
  if (normalizeEmail(b.email) || phoneNameKey(b)) return null;
  return nameKey(b) || null;
}

/**
 * Copy the bidder roster of one event into another, linked to the Directory.
 * Bidders already in the target event are skipped. With "keep", each bidder
 * keeps their paddle unless it is taken in the target event, in which case
 * they get the next free paddle; with "renumber", everyone is numbered from
 * the next free paddle in source paddle order.
 */
export async function copyBiddersFromEvent(
  db: AuctionDB,
  opts: {
    fromEventId: number;
    toEventId: number;
    paddles: CopyPaddleMode;
    now?: Date;
  }
): Promise<CopyBiddersResult> {
  const { fromEventId, toEventId, paddles } = opts;
  const now = opts.now ?? new Date();
  const result: CopyBiddersResult = { added: 0, skipped: 0, renumbered: [] };
  if (fromEventId === toEventId) return result;

  // Include masterBidders: findOrCreateMasterBidder writes that store inside
  // this transaction.
  return mutateWithEventTables(
    db,
    toEventId,
    [db.bidders, db.masterBidders],
    async () => {
      const source = (
        await db.bidders.where("eventId").equals(fromEventId).toArray()
      ).sort((a, b) => a.paddleNumber - b.paddleNumber);
      const existing = await db.bidders
        .where("eventId")
        .equals(toEventId)
        .toArray();

      const masterKeys = new Set<string>();
      const emails = new Set<string>();
      const phoneNames = new Set<string>();
      const names = new Set<string>();
      const taken = new Set<number>();
      const remember = (b: Bidder) => {
        if (b.masterSyncKey) masterKeys.add(b.masterSyncKey);
        const email = normalizeEmail(b.email);
        if (email) emails.add(email);
        const pn = phoneNameKey(b);
        if (pn) phoneNames.add(pn);
        names.add(nameKey(b));
        taken.add(b.paddleNumber);
      };
      existing.forEach(remember);

      // master: the Directory entry the copy links to, or undefined to leave
      // the copy unlinked. useMaster: take contact details from it.
      const toAdd: Array<{
        row: Bidder;
        master: MasterBidder | undefined;
        useMaster: boolean;
      }> = [];
      for (const b of source) {
        const email = normalizeEmail(b.email);
        const pn = phoneNameKey(b);
        const bare = bareNameKey(b);
        if (
          (b.masterSyncKey && masterKeys.has(b.masterSyncKey)) ||
          (email && emails.has(email)) ||
          (pn && phoneNames.has(pn)) ||
          (bare && names.has(bare))
        ) {
          result.skipped++;
          continue;
        }
        const linked = b.masterSyncKey
          ? await db.masterBidders.where("syncKey").equals(b.masterSyncKey).first()
          : undefined;
        // An entry under another name may be someone else's (a shared
        // household email). Keep an existing link as it is, but never take
        // that entry's details, never add a new link to it, and never write
        // this bidder's details into it: look it up before findOrCreate,
        // which fills the matched entry's blanks.
        const fields = {
          firstName: b.firstName,
          lastName: b.lastName,
          email: b.email,
          phone: b.phone,
          mailingAddress: b.mailingAddress,
          resaleNumber: b.resaleNumber,
        };
        const match = linked ?? (await findMasterBidder(db, fields));
        const samePerson = !match || nameKey(match) === nameKey(b);
        const master =
          linked ??
          (samePerson ? await findOrCreateMasterBidder(db, fields, now) : undefined);
        if (master && masterKeys.has(master.syncKey)) {
          result.skipped++;
          continue;
        }
        if (master) masterKeys.add(master.syncKey);
        if (email) emails.add(email);
        if (pn) phoneNames.add(pn);
        names.add(nameKey(b));
        toAdd.push({ row: b, master, useMaster: !!linked && samePerson });
      }

      // Place kept paddles first so a later bidder cannot take one that an
      // earlier conflict was renumbered onto.
      const paddleFor = new Map<Bidder, number>();
      if (paddles === "keep") {
        for (const { row } of toAdd) {
          if (!taken.has(row.paddleNumber)) {
            paddleFor.set(row, row.paddleNumber);
            taken.add(row.paddleNumber);
          }
        }
      }
      let next = taken.size ? Math.max(...Array.from(taken)) + 1 : 1;
      for (const { row } of toAdd) {
        if (paddleFor.has(row)) continue;
        paddleFor.set(row, next);
        if (paddles === "keep") {
          result.renumbered.push({
            name: `${row.firstName} ${row.lastName}`.trim(),
            from: row.paddleNumber,
            to: next,
          });
        }
        next++;
      }

      // A row already linked to its own entry takes its contact details from
      // that entry as it is now, blanks included, as Look up in BidderForm
      // does: it may have been edited or cleared since the old auction. Any
      // other row keeps its own. The name always stays the row's own.
      for (const { row, master, useMaster } of toAdd) {
        const contact = useMaster && master ? master : row;
        await db.bidders.add({
          eventId: toEventId,
          paddleNumber: paddleFor.get(row)!,
          firstName: row.firstName,
          lastName: row.lastName,
          email: contact.email,
          phone: contact.phone,
          mailingAddress: contact.mailingAddress,
          resaleNumber: contact.resaleNumber,
          masterSyncKey: master?.syncKey,
          createdAt: now,
          updatedAt: now,
        });
        result.added++;
      }
      return result;
    }
  );
}
