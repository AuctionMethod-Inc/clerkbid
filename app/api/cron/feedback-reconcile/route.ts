import { NextResponse } from "next/server";
import {
  listPendingDeliveries,
  updateFeedbackDelivery,
} from "@/lib/feedback/persist";
import {
  buildIssueBody,
  buildIssueLabels,
  buildIssueTitle,
  buildSlackTopLevel,
} from "@/lib/feedback/issueBody";
import {
  createFeedbackIssue,
  isGitHubIssueConfigured,
  updateIssueHiddenMeta,
} from "@/lib/feedback/githubIssue";
import {
  isSlackConfigured,
  postFeedbackSlackMessage,
} from "@/lib/feedback/slackNotify";
import { DEFAULT_FEEDBACK_REPO } from "@/lib/feedback/githubIssue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH = 20;

function verifyCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Retries GitHub issue creation and the Slack top-level post for submissions
 * where either failed at submit time. Scheduled in vercel.json. Idempotent:
 * only rows still missing an id are touched, and each step records its
 * result before the next runs.
 */
export async function GET(req: Request) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const summary = { scanned: 0, issuesCreated: 0, slackPosted: 0, errors: [] as string[] };

  try {
    const rows = await listPendingDeliveries(BATCH);
    summary.scanned = rows.length;

    for (const row of rows) {
      let issueNumber = row.github_issue_number;
      let issueUrl: string | null = issueNumber
        ? `https://github.com/${process.env.GITHUB_FEEDBACK_REPO?.trim() || DEFAULT_FEEDBACK_REPO}/issues/${issueNumber}`
        : null;
      let issueError: string | null = null;
      let slackChannelId = row.slack_channel_id;
      let slackTs = row.slack_ts;
      let slackError: string | null = null;

      if (issueNumber == null) {
        if (!isGitHubIssueConfigured()) {
          issueError = "GITHUB_FEEDBACK_TOKEN is not set.";
        } else {
          const created = await createFeedbackIssue({
            title: buildIssueTitle(row.kind, row.message),
            body: buildIssueBody({
              submissionId: row.id,
              kind: row.kind,
              source: row.source,
              trust: row.trust,
              name: row.name ?? "",
              email: row.email,
              message: row.message,
              steps: row.steps,
              vendorName: row.vendor_name,
              orgRole: row.org_role,
              pagePath: row.page_path,
              appVersion: row.app_version,
              userAgent: row.user_agent,
              online: null,
              attachments: row.attachments ?? [],
              slackChannelId,
              slackTs,
            }),
            labels: buildIssueLabels(row.kind, row.source, row.trust),
          });
          if (created.ok) {
            issueNumber = created.number;
            issueUrl = created.url;
            summary.issuesCreated++;
          } else {
            issueError = created.reason;
            summary.errors.push(`row ${row.id} issue: ${created.reason}`);
          }
        }
      }

      if (slackTs == null) {
        if (!isSlackConfigured()) {
          slackError = "SLACK_BOT_TOKEN is not set.";
        } else {
          const posted = await postFeedbackSlackMessage({
            text: buildSlackTopLevel({
              issueNumber,
              issueUrl,
              submissionId: row.id,
              kind: row.kind,
              trust: row.trust,
              name: row.name ?? "",
              email: row.email,
              vendorName: row.vendor_name,
              orgRole: row.org_role,
              appVersion: row.app_version,
              pagePath: row.page_path,
              message: row.message,
              attachments: row.attachments ?? [],
            }),
          });
          if (posted.ok) {
            slackChannelId = posted.channel;
            slackTs = posted.ts;
            summary.slackPosted++;
            if (issueNumber != null) {
              await updateIssueHiddenMeta(issueNumber, {
                submissionId: row.id,
                slackChannelId,
                slackTs,
              });
            }
          } else {
            slackError = posted.reason;
            summary.errors.push(`row ${row.id} slack: ${posted.reason}`);
          }
        }
      }

      await updateFeedbackDelivery(row.id, {
        githubIssueNumber: issueNumber,
        issueError,
        slackChannelId,
        slackTs,
        slackError,
      });
    }

    return NextResponse.json({ ok: true, ...summary, errors: summary.errors.slice(0, 20) });
  } catch (e) {
    console.error("[cron/feedback-reconcile]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Cron failed." },
      { status: 500 }
    );
  }
}
