/**
 * Daily cap on screenshot upload permissions, backed by the
 * feedback_upload_tokens table. Each permission is recorded when it is
 * handed out, so collecting many permissions before uploading does not get
 * past the cap. Count and insert run under a per-user advisory lock in one
 * transaction, so parallel requests cannot slip past it either.
 */

import type { TxClient } from "@/lib/db/postgres";
import { ATTACHMENT_LIMITS } from "@/lib/feedback/attachments";

/**
 * Records one upload permission for `userId` if the user is under the daily
 * cap. Returns false (and records nothing) at the cap. Must be called inside
 * a transaction: the advisory lock is released at COMMIT/ROLLBACK.
 */
export async function claimUploadToken(
  client: TxClient,
  userId: number
): Promise<boolean> {
  await client.sql`SELECT pg_advisory_xact_lock(hashtext(${`feedback-upload:${userId}`}))`;

  const { rows } = await client.sql<{ n: string }>`
    SELECT COUNT(*) AS n FROM feedback_upload_tokens
    WHERE user_id = ${userId} AND issued_at > NOW() - INTERVAL '1 day'
  `;
  if (Number(rows[0]?.n ?? 0) >= ATTACHMENT_LIMITS.maxUploadsPerDay) return false;

  await client.sql`INSERT INTO feedback_upload_tokens (user_id) VALUES (${userId})`;
  return true;
}
