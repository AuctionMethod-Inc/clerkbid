/**
 * Postgres-backed rate limiting for the public feedback form. Serverless
 * functions have no shared memory, so counts come from the table itself.
 *
 * Limits: 5 submissions per IP per hour, 10 per email per day.
 * Disable with FEEDBACK_RATE_LIMIT_ENABLED=0 (default is on).
 */

import { createHash } from "crypto";
import { sql } from "@/lib/db/postgres";

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

/**
 * Throws if the table does not exist; the caller treats that as "not
 * enforced" so the form keeps working before the migration runs.
 */
export async function checkFeedbackRateLimit(input: {
  ipHash: string | null;
  email: string;
}): Promise<RateLimitResult> {
  if (!isRateLimitEnabled()) return { ok: true };

  const { rows } = await sql<{ ip_count: string; email_count: string }>`
    SELECT
      (SELECT COUNT(*) FROM feedback_submissions
        WHERE ip_hash IS NOT NULL AND ip_hash = ${input.ipHash}
          AND created_at > NOW() - INTERVAL '1 hour') AS ip_count,
      (SELECT COUNT(*) FROM feedback_submissions
        WHERE lower(email) = ${input.email.toLowerCase()}
          AND created_at > NOW() - INTERVAL '1 day') AS email_count
  `;
  const ipCount = Number(rows[0]?.ip_count ?? 0);
  const emailCount = Number(rows[0]?.email_count ?? 0);

  if (input.ipHash && ipCount >= RATE_LIMITS.perIpPerHour) {
    return { ok: false, reason: "Too many messages from this network. Try again in an hour." };
  }
  if (emailCount >= RATE_LIMITS.perEmailPerDay) {
    return { ok: false, reason: "Too many messages from this email today. Try again tomorrow." };
  }
  return { ok: true };
}
