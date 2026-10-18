/**
 * Insert and update rows in feedback_submissions. See
 * db/migrate_feedback_submissions.sql.
 */

import { sql, withTransaction, type TxClient } from "@/lib/db/postgres";
import type { FeedbackKind } from "./validate";
import type { FeedbackSource, FeedbackTrust } from "./issueBody";
import { lockAndCheckRateLimit } from "./rateLimit";

export type NewFeedbackRow = {
  source: FeedbackSource;
  kind: FeedbackKind;
  name: string | null;
  email: string;
  message: string;
  steps: string | null;
  userId: number | null;
  vendorId: number | null;
  orgRole: string | null;
  eventSyncId: string | null;
  pagePath: string | null;
  appVersion: string | null;
  userAgent: string | null;
  ipHash: string | null;
  trust: FeedbackTrust;
};

export type InsertResult =
  | { ok: true; id: number }
  | { ok: false; limited: string };

async function insertRow(client: TxClient, row: NewFeedbackRow): Promise<number> {
  const { rows } = await client.sql<{ id: number }>`
    INSERT INTO feedback_submissions (
      source, kind, name, email, message, steps,
      user_id, vendor_id, org_role, event_sync_id,
      page_path, app_version, user_agent, ip_hash, trust
    ) VALUES (
      ${row.source}, ${row.kind}, ${row.name}, ${row.email}, ${row.message}, ${row.steps},
      ${row.userId}, ${row.vendorId}, ${row.orgRole}, ${row.eventSyncId},
      ${row.pagePath}, ${row.appVersion}, ${row.userAgent}, ${row.ipHash}, ${row.trust}
    )
    RETURNING id
  `;
  const id = rows[0]?.id;
  if (id == null) throw new Error("Insert returned no id.");
  return Number(id);
}

/**
 * Rate-limit check and insert in one transaction under advisory locks, so
 * concurrent submissions from the same IP or email are counted in order.
 * Throws if the table does not exist (caller falls back to email-only).
 */
export async function insertFeedbackSubmission(row: NewFeedbackRow): Promise<InsertResult> {
  return withTransaction(async (client) => {
    const rl = await lockAndCheckRateLimit(client, {
      ipHash: row.ipHash,
      email: row.email,
    });
    if (!rl.ok) return { ok: false, limited: rl.reason };
    const id = await insertRow(client, row);
    return { ok: true, id };
  });
}

export async function updateFeedbackDelivery(
  id: number,
  patch: {
    emailSent?: boolean;
    githubIssueNumber?: number | null;
    issueError?: string | null;
    slackChannelId?: string | null;
    slackTs?: string | null;
    slackError?: string | null;
  }
): Promise<void> {
  await sql`
    UPDATE feedback_submissions SET
      email_sent = COALESCE(${patch.emailSent ?? null}, email_sent),
      github_issue_number = COALESCE(${patch.githubIssueNumber ?? null}, github_issue_number),
      issue_error = ${patch.issueError ?? null},
      slack_channel_id = COALESCE(${patch.slackChannelId ?? null}, slack_channel_id),
      slack_ts = COALESCE(${patch.slackTs ?? null}, slack_ts),
      slack_error = ${patch.slackError ?? null}
    WHERE id = ${id}
  `;
}

export async function saveFeedbackAttachments(id: number, urls: string[]): Promise<void> {
  await sql`
    UPDATE feedback_submissions SET attachments = ${JSON.stringify(urls)}::jsonb
    WHERE id = ${id}
  `;
}

export type UserContext = {
  id: number;
  vendorId: number;
  orgRole: string;
  vendorName: string;
};

/**
 * Context for a signed-in submitter. Only ever called with the email from an
 * authenticated session: a caller-typed email must not confer identity.
 */
export async function findUserByEmail(email: string): Promise<UserContext | null> {
  const { rows } = await sql<{
    id: number;
    vendor_id: number;
    org_role: string;
    vendor_name: string;
  }>`
    SELECT u.id, u.vendor_id, COALESCE(u.org_role, 'admin') AS org_role, v.name AS vendor_name
    FROM users u
    JOIN vendors v ON v.id = u.vendor_id
    WHERE u.email = ${email.toLowerCase()}
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.id),
    vendorId: Number(r.vendor_id),
    orgRole: r.org_role,
    vendorName: r.vendor_name,
  };
}

/** Rows whose GitHub issue or Slack post is still missing, for the reconcile cron. */
export type PendingFeedbackRow = {
  id: number;
  kind: FeedbackKind;
  source: FeedbackSource;
  trust: FeedbackTrust;
  name: string | null;
  email: string;
  message: string;
  steps: string | null;
  org_role: string | null;
  page_path: string | null;
  app_version: string | null;
  user_agent: string | null;
  github_issue_number: number | null;
  slack_channel_id: string | null;
  slack_ts: string | null;
  vendor_name: string | null;
  attachments: string[] | null;
};

export async function listPendingDeliveries(limit: number): Promise<PendingFeedbackRow[]> {
  const { rows } = await sql<PendingFeedbackRow>`
    SELECT f.id, f.kind, f.source, f.trust, f.name, f.email, f.message, f.steps,
      f.org_role, f.page_path, f.app_version, f.user_agent,
      f.github_issue_number, f.slack_channel_id, f.slack_ts,
      v.name AS vendor_name, f.attachments
    FROM feedback_submissions f
    LEFT JOIN vendors v ON v.id = f.vendor_id
    WHERE f.status NOT IN ('spam', 'closed')
      AND f.created_at > NOW() - INTERVAL '30 days'
      AND (f.github_issue_number IS NULL OR f.slack_ts IS NULL)
    ORDER BY f.id ASC
    LIMIT ${limit}
  `;
  return rows;
}
