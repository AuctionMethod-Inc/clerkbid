/**
 * Posts the top-level "new feedback" message to Slack with the ClerkBid Gate
 * bot token. A bot token (not an incoming webhook) is required because the
 * response must carry the message timestamp: that timestamp identifies the
 * thread that the routine and the slack-approval check read later.
 *
 * Env:
 *   SLACK_BOT_TOKEN             xoxb-... (ClerkBid Gate app)
 *   SLACK_FEEDBACK_CHANNEL_ID   default C0C9HLJ9H3Q (#clerkbid-feedback-loop)
 */

export const DEFAULT_FEEDBACK_CHANNEL_ID = "C0C9HLJ9H3Q";

export type SlackPostResult =
  | { ok: true; channel: string; ts: string }
  | { ok: false; reason: string };

function config(): { token: string; channel: string } | null {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;
  const channel =
    process.env.SLACK_FEEDBACK_CHANNEL_ID?.trim() || DEFAULT_FEEDBACK_CHANNEL_ID;
  return { token, channel };
}

export function isSlackConfigured(): boolean {
  return config() != null;
}

export async function postFeedbackSlackMessage(options: {
  text: string;
  threadTs?: string;
}): Promise<SlackPostResult> {
  const cfg = config();
  if (!cfg) return { ok: false, reason: "SLACK_BOT_TOKEN is not set." };
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: cfg.channel,
        text: options.text,
        thread_ts: options.threadTs,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const j = (await res.json()) as {
      ok: boolean;
      error?: string;
      ts?: string;
      channel?: string;
    };
    if (!j.ok || !j.ts) {
      return { ok: false, reason: `Slack: ${j.error ?? `HTTP ${res.status}`}` };
    }
    return { ok: true, channel: j.channel ?? cfg.channel, ts: j.ts };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
