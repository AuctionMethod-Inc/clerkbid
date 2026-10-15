// The production gate for ClerkBid. Run by .github/workflows/slack-approval.yml.
//
// Decision (pure, unit tested in slack-approval-gate.test.mjs):
//   1. The PR body names its Slack thread:  slack-thread: <channel>/<ts>
//   2. The thread holds a "ready <sha>" post for the PR's current head commit,
//      from READY_POSTER when that is set.
//   3. After that post, an approver (by Slack user ID) replied with an approval
//      and did not later reply with a hold.
//   4. The deploy window is open in WINDOW_TZ, or the approval says "now".
//
// Exit code 0 = merge allowed. Anything else = blocked, with the reason printed.

export const APPROVE_RE =
  /\b(approve[ds]?|approval|ship it|ship|deploy|go live|merge it|put (?:it|this) (?:in|into) production|roll ?back|revert)\b/i;
export const HOLD_RE =
  /\b(hold|wait|not yet|don'?t (?:ship|deploy|merge)|do not (?:ship|deploy|merge)|cancel)\b/i;
export const NOW_RE = /\b(now|immediately|right away|asap|roll ?back|revert)\b/i;
export const READY_RE = /\bready\s+([0-9a-f]{7,40})\b/i;
export const THREAD_RE = /slack-thread:\s*([A-Z0-9]+)\/(\d+\.\d+)/;

export function parseThreadRef(body) {
  const m = (body ?? "").match(THREAD_RE);
  return m ? { channel: m[1], ts: m[2] } : null;
}

function hhmm(s) {
  const [h, m] = String(s).split(":").map((x) => parseInt(x, 10));
  return h * 60 + (m || 0);
}

/** Minutes since midnight for `date` in `tz`. */
export function localMinutes(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === "hour").value, 10) % 24;
  const m = parseInt(parts.find((p) => p.type === "minute").value, 10);
  return h * 60 + m;
}

/** True when local time is within [start, end); the range may cross midnight. */
export function inDeployWindow(date, tz, start, end) {
  const now = localMinutes(date, tz);
  const s = hhmm(start);
  const e = hhmm(end);
  if (s === e) return true;
  if (s < e) return now >= s && now < e;
  return now >= s || now < e;
}

function tsNum(ts) {
  return parseFloat(ts);
}

/**
 * @param {object} p
 * @param {Array<{user?:string, bot_id?:string, text?:string, ts:string}>} p.messages thread, any order
 * @param {string} p.headSha
 * @param {string[]} p.approvers Slack user IDs
 * @param {string} [p.readyPoster] Slack user ID that may post "ready"; empty = anyone
 * @param {Date} p.now
 * @param {string} p.tz
 * @param {string} p.windowStart "HH:MM"
 * @param {string} p.windowEnd "HH:MM"
 */
export function decide(p) {
  const msgs = [...(p.messages ?? [])].sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
  const head = (p.headSha ?? "").toLowerCase();
  const approvers = new Set(p.approvers ?? []);

  // Latest "ready <sha>" for this head.
  let ready = null;
  for (const m of msgs) {
    const match = (m.text ?? "").match(READY_RE);
    if (!match) continue;
    if (p.readyPoster && m.user !== p.readyPoster) continue;
    const sha = match[1].toLowerCase();
    if (!head.startsWith(sha)) continue;
    ready = m;
  }
  if (!ready) {
    return { ok: false, reason: `not ready: no "ready <sha>" post for ${head.slice(0, 7)}` };
  }

  // Approvals and holds after it, from approvers only.
  let approval = null;
  for (const m of msgs) {
    if (tsNum(m.ts) <= tsNum(ready.ts)) continue;
    if (!approvers.has(m.user)) continue;
    const text = m.text ?? "";
    if (HOLD_RE.test(text)) {
      approval = null;
      continue;
    }
    if (APPROVE_RE.test(text)) approval = m;
  }
  if (!approval) {
    return { ok: false, reason: `awaiting approval for ${head.slice(0, 7)}` };
  }

  const override = NOW_RE.test(approval.text ?? "");
  if (!override && !inDeployWindow(p.now, p.tz, p.windowStart, p.windowEnd)) {
    return {
      ok: false,
      reason: `approved by ${approval.user}, waiting for deploy window ${p.windowStart}-${p.windowEnd} ${p.tz}`,
    };
  }
  return {
    ok: true,
    reason: `approved by ${approval.user}${override ? " (window override)" : ""}`,
  };
}

// ---------------------------------------------------------------------------
// I/O

async function ghJson(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "clerkbid-slack-approval",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

async function slackReplies(token, channel, ts) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const url = new URL("https://slack.com/api/conversations.replies");
    url.searchParams.set("channel", channel);
    url.searchParams.set("ts", ts);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = await res.json();
    if (!j.ok) throw new Error(`Slack conversations.replies: ${j.error}`);
    out.push(...(j.messages ?? []));
    cursor = j.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out;
}

async function main() {
  const env = process.env;
  const required = ["SLACK_BOT_TOKEN", "GITHUB_TOKEN", "GITHUB_REPOSITORY", "PR_NUMBER", "HEAD_SHA"];
  for (const k of required) {
    if (!env[k]) throw new Error(`Missing ${k}`);
  }

  const pr = await ghJson(`/repos/${env.GITHUB_REPOSITORY}/pulls/${env.PR_NUMBER}`, env.GITHUB_TOKEN);
  const ref = parseThreadRef(pr.body);
  if (!ref) {
    return block('PR body has no "slack-thread: <channel>/<ts>" line.');
  }
  const messages = await slackReplies(env.SLACK_BOT_TOKEN, ref.channel, ref.ts);

  const verdict = decide({
    messages,
    headSha: env.HEAD_SHA,
    approvers: (env.APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    readyPoster: (env.READY_POSTER ?? "").trim(),
    now: new Date(),
    tz: env.WINDOW_TZ || "America/New_York",
    windowStart: env.WINDOW_START || "23:30",
    windowEnd: env.WINDOW_END || "06:00",
  });

  const line = `slack-approval: ${verdict.ok ? "PASS" : "BLOCKED"} — ${verdict.reason}`;
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
  if (!verdict.ok) process.exit(1);
}

function block(reason) {
  console.log(`slack-approval: BLOCKED — ${reason}`);
  process.exit(1);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  main().catch((e) => {
    console.error(`slack-approval: ERROR — ${e.message}`);
    process.exit(1);
  });
}
