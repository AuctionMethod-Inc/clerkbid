/**
 * Rate limiting for the public feedback form, backed by the
 * feedback_submissions table. Serverless functions share no memory, so the
 * count comes from Postgres, and the check runs inside the same transaction
 * as the insert under an advisory lock so a concurrent burst cannot slip
 * past the limit (see persist.ts).
 *
 * Limits: 5 submissions per IP per hour, 10 per email per day.
 * Disable with FEEDBACK_RATE_LIMIT_ENABLED=0 (default is on).
 */

import { createHash } from "crypto";
import type { TxClient } from "@/lib/db/postgres";

export const RATE_LIMITS = {
  perIpPerHour: 5,
  perEmailPerDay: 10,
} as const;

export function isRateLimitEnabled(): boolean {
  return (process.env.FEEDBACK_RATE_LIMIT_ENABLED?.trim() ?? "1") !== "0";
}

export function getClientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  return real || null;
}

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = process.env.FEEDBACK_IP_HASH_SALT?.trim() ?? "";
  return createHash("sha256").update(`${salt}:${ip}`, "utf8").digest("hex");
}

export type RateLimitResult = { ok: true } | { ok: false; reason: string };

/** Pure decision from counts; unit tested. */
export function evaluateRateLimit(input: {
  ipHash: string | null;
  ipCount: number;
  emailCount: number;
}): RateLimitResult {
  if (input.ipHash && input.ipCount >= RATE_LIMITS.perIpPerHour) {
    return {
      ok: false,
      reason: "Too many messages from this network. Try again in an hour.",
    };
  }
  if (input.emailCount >= RATE_LIMITS.perEmailPerDay) {
    return {
      ok: false,
      reason: "Too many messages from this email today. Try again tomorrow.",
    };
  }
  return { ok: true };
}

/**
 * Serializes concurrent submissions from the same IP and email, then counts.
 * Must be called inside a transaction: the advisory locks are released at
 * COMMIT/ROLLBACK. Lock order is always ip then email, so no deadlocks.
 */
export async function lockAndCheckRateLimit(
  client: TxClient,
  input: { ipHash: string | null; email: string }
): Promise<RateLimitResult> {
  if (!isRateLimitEnabled()) return { ok: true };

  const email = input.email.toLowerCase();
  const ipKey = input.ipHash ?? `email:${email}`;
  await client.sql`SELECT pg_advisory_xact_lock(hashtext(${`ip:${ipKey}`}))`;
  await client.sql`SELECT pg_advisory_xact_lock(hashtext(${`email:${email}`}))`;

  const { rows } = await client.sql<{ ip_count: string; email_count: string }>`
    SELECT
      (SELECT COUNT(*) FROM feedback_submissions
        WHERE ip_hash IS NOT NULL AND ip_hash = ${input.ipHash}
          AND created_at > NOW() - INTERVAL '1 hour') AS ip_count,
      (SELECT COUNT(*) FROM feedback_submissions
        WHERE lower(email) = ${email}
          AND created_at > NOW() - INTERVAL '1 day') AS email_count
  `;
  return evaluateRateLimit({
    ipHash: input.ipHash,
    ipCount: Number(rows[0]?.ip_count ?? 0),
    emailCount: Number(rows[0]?.email_count ?? 0),
  });
}
