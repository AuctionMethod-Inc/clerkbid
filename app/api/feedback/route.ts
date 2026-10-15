import { NextResponse } from "next/server";
import { getServerSession, type Session } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { sendFeedbackEmail } from "@/lib/email/sendFeedbackEmail";
import { validateFeedbackBody } from "@/lib/feedback/validate";
import { getClientIp, hashIp } from "@/lib/feedback/rateLimit";
import {
  findUserByEmail,
  insertFeedbackSubmission,
  updateFeedbackDelivery,
  type UserContext,
} from "@/lib/feedback/persist";
import {
  buildIssueBody,
  buildIssueLabels,
  buildIssueTitle,
  buildSlackTopLevel,
  type FeedbackSource,
  type FeedbackTrust,
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FALLBACK_ERROR =
  "We could not send your message. You can email info@auctionmethod.com directly.";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Feedback pipeline:
 *   validate → rate limit → persist → email (unchanged) → GitHub issue → Slack
 *
 * Every step after validation is best-effort. The submitter gets a success
 * response if the message was persisted or emailed; failures of the issue or
 * Slack steps are recorded on the row for the hourly routine to reconcile.
 */
export async function POST(req: Request) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }

    const validated = validateFeedbackBody(raw);
    if (!validated.ok) {
      return NextResponse.json(
        { error: validated.error },
        { status: validated.status }
      );
    }
    if (validated.honeypot) {
      return NextResponse.json({ ok: true });
    }
    const { name, email, message, kind, steps, context } = validated.value;

    // Identity comes only from an authenticated session. The typed email is
    // never matched against accounts: anyone can type a customer's address,
    // and "trust:user" is what lets the routine build without a human 👍.
    let session: Session | null = null;
    try {
      session = await getServerSession(authOptions);
    } catch {
      session = null;
    }
    const sessionEmail = session?.user?.email?.trim().toLowerCase() ?? null;

    let user: UserContext | null = null;
    if (sessionEmail) {
      try {
        user = await findUserByEmail(sessionEmail);
      } catch (e) {
        console.warn("[feedback] user lookup skipped:", errMsg(e));
      }
    }

    const source: FeedbackSource = sessionEmail ? "app" : "form";
    const trust: FeedbackTrust = sessionEmail ? "user" : "anonymous";
    const ipHash = hashIp(getClientIp(req));
    const userAgent = req.headers.get("user-agent")?.slice(0, 512) ?? null;

    // Persist, with the rate-limit check in the same transaction. Until the
    // table exists this throws and the route falls back to email only.
    let submissionId: number | null = null;
    try {
      const inserted = await insertFeedbackSubmission({
        source,
        kind,
        name: name || null,
        email,
        message,
        steps,
        userId: user?.id ?? null,
        vendorId: user?.vendorId ?? null,
        orgRole: user?.orgRole ?? null,
        eventSyncId: context.eventSyncId,
        pagePath: context.pagePath,
        appVersion: context.appVersion,
        userAgent,
        ipHash,
        trust,
      });
      if (!inserted.ok) {
        return NextResponse.json({ error: inserted.limited }, { status: 429 });
      }
      submissionId = inserted.id;
    } catch (e) {
      console.error("[feedback] persist failed (run db/migrate_feedback_submissions.sql?):", errMsg(e));
    }

    // Email to info@ (unchanged behavior).
    const sent = await sendFeedbackEmail({ name, email, message });
    if (!sent.ok) {
      console.error("[feedback]", sent.code, sent.reason);
    }

    if (submissionId == null) {
      // Nothing persisted: fall back to the original email-only contract.
      if (sent.ok) return NextResponse.json({ ok: true });
      return emailFailureResponse(sent.code);
    }

    // GitHub issue.
    let issueNumber: number | null = null;
    let issueUrl: string | null = null;
    let issueError: string | null = null;
    if (isGitHubIssueConfigured()) {
      const issueInput = {
        submissionId,
        kind,
        source,
        trust,
        name,
        email,
        message,
        steps,
        vendorName: user?.vendorName ?? null,
        orgRole: user?.orgRole ?? null,
        pagePath: context.pagePath,
        appVersion: context.appVersion,
        userAgent,
        online: context.online,
        slackChannelId: null,
        slackTs: null,
      };
      const created = await createFeedbackIssue({
        title: buildIssueTitle(kind, message),
        body: buildIssueBody(issueInput),
        labels: buildIssueLabels(kind, source, trust),
      });
      if (created.ok) {
        issueNumber = created.number;
        issueUrl = created.url;
      } else {
        issueError = created.reason;
        console.error("[feedback] issue not created:", created.reason);
      }
    } else {
      issueError = "GITHUB_FEEDBACK_TOKEN is not set.";
    }

    // Slack top-level post.
    let slackChannelId: string | null = null;
    let slackTs: string | null = null;
    let slackError: string | null = null;
    if (isSlackConfigured()) {
      const posted = await postFeedbackSlackMessage({
        text: buildSlackTopLevel({
          issueNumber,
          issueUrl,
          submissionId,
          kind,
          trust,
          name,
          email,
          vendorName: user?.vendorName ?? null,
          orgRole: user?.orgRole ?? null,
          appVersion: context.appVersion,
          pagePath: context.pagePath,
          message,
        }),
      });
      if (posted.ok) {
        slackChannelId = posted.channel;
        slackTs = posted.ts;
      } else {
        slackError = posted.reason;
        console.error("[feedback] slack not posted:", posted.reason);
      }
    } else {
      slackError = "SLACK_BOT_TOKEN is not set.";
    }

    // Tell the issue where its Slack thread is.
    if (issueNumber != null && slackTs) {
      const meta = await updateIssueHiddenMeta(issueNumber, {
        submissionId,
        slackChannelId,
        slackTs,
      });
      if (!meta.ok) console.warn("[feedback] issue meta not updated:", meta.reason);
    }

    try {
      await updateFeedbackDelivery(submissionId, {
        emailSent: sent.ok,
        githubIssueNumber: issueNumber,
        issueError,
        slackChannelId,
        slackTs,
        slackError,
      });
    } catch (e) {
      console.warn("[feedback] delivery status not saved:", errMsg(e));
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { error: "Something went wrong. Try again later." },
      { status: 500 }
    );
  }
}

function emailFailureResponse(code: string) {
  if (code === "domain_not_verified") {
    return NextResponse.json(
      {
        error: FALLBACK_ERROR,
        hint: "For administrators: the domain in RESEND_FROM must be verified in Resend. Open https://resend.com/domains, add that domain, publish the DNS records Resend provides, wait until it shows “Verified,” then try again. Until then, use RESEND_FROM with a verified domain (e.g. clerkbid.com if verified there) or Resend’s onboarding test sender for non-production.",
      },
      { status: 503 }
    );
  }
  if (code === "missing_config") {
    return NextResponse.json(
      {
        error: FALLBACK_ERROR,
        hint: "For administrators: set RESEND_API_KEY and RESEND_FROM in Vercel (Environment Variables) and redeploy.",
      },
      { status: 503 }
    );
  }
  return NextResponse.json(
    {
      error: FALLBACK_ERROR,
      hint: "For administrators: check Vercel function logs for the Resend API response.",
    },
    { status: 503 }
  );
}
