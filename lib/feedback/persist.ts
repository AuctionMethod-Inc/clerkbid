/**
 * Insert and update rows in feedback_submissions. See
 * db/migrate_feedback_submissions.sql.
 */

import { sql } from "@/lib/db/postgres";
import type { FeedbackKind } from "./validate";
import type { FeedbackSource, FeedbackTrust } from "./issueBody";

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

export async function insertFeedbackSubmission(row: NewFeedbackRow): Promise<number> {
  const { rows } = await sql<{ id: number }>`
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

/** Looks up a registered user by email for the trust tier and context. */
export async function findUserByEmail(email: string): Promise<{
  id: number;
  vendorId: number;
  orgRole: string;
  vendorName: string;
} | null> {
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
