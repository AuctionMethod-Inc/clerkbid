/**
 * Creates the GitHub issue that mirrors a feedback submission.
 *
 * Env:
 *   GITHUB_FEEDBACK_TOKEN  fine-grained token, Issues: read/write on the repo
 *   GITHUB_FEEDBACK_REPO   "owner/repo" (default AuctionMethod-Inc/clerkbid)
 *
 * Everything here is best-effort: the caller records failures on the
 * submission row and the feedback-reconcile cron retries them.
 */

import { findHiddenMeta, hiddenMetaLine, parseHiddenMeta } from "./issueBody";

export const DEFAULT_FEEDBACK_REPO = "AuctionMethod-Inc/clerkbid";

export type IssueResult =
  | { ok: true; number: number; url: string }
  | { ok: false; reason: string };

function config(): { token: string; repo: string } | null {
  const token = process.env.GITHUB_FEEDBACK_TOKEN?.trim();
  if (!token) return null;
  const repo = process.env.GITHUB_FEEDBACK_REPO?.trim() || DEFAULT_FEEDBACK_REPO;
  return { token, repo };
}

export function isGitHubIssueConfigured(): boolean {
  return config() != null;
}

async function gh(
  cfg: { token: string; repo: string },
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown
): Promise<Response> {
  return fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "clerkbid-feedback",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

export async function createFeedbackIssue(input: {
  title: string;
  body: string;
  labels: string[];
}): Promise<IssueResult> {
  const cfg = config();
  if (!cfg) {
    return { ok: false, reason: "GITHUB_FEEDBACK_TOKEN is not set." };
  }
  try {
    const res = await gh(cfg, "POST", "/issues", {
      title: input.title,
      body: input.body,
      labels: input.labels,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      return { ok: false, reason: `GitHub ${res.status}: ${text}` };
    }
    const j = (await res.json()) as { number: number; html_url: string };
    return { ok: true, number: j.number, url: j.html_url };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Rewrites the hidden metadata comment on an issue (used to add the Slack
 * thread timestamp once the channel post exists).
 */
export async function updateIssueHiddenMeta(
  issueNumber: number,
  patch: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cfg = config();
  if (!cfg) return { ok: false, reason: "GITHUB_FEEDBACK_TOKEN is not set." };
  try {
    const cur = await gh(cfg, "GET", `/issues/${issueNumber}`);
    if (!cur.ok) return { ok: false, reason: `GitHub ${cur.status} reading issue.` };
    const { body } = (await cur.json()) as { body: string | null };
    const existing = body ?? "";
    const meta = { ...(parseHiddenMeta(existing) ?? {}), ...patch };
    const line = hiddenMetaLine(meta);
    const span = findHiddenMeta(existing);
    const next = span
      ? existing.slice(0, span.start) + line + existing.slice(span.end)
      : `${existing}\n\n${line}`;
    const res = await gh(cfg, "PATCH", `/issues/${issueNumber}`, { body: next });
    if (!res.ok) return { ok: false, reason: `GitHub ${res.status} updating issue.` };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
