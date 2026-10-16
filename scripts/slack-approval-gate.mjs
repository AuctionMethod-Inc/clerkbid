// The production gate for ClerkBid. Run by .github/workflows/slack-approval.yml.
//
// Decision (pure, unit tested in slack-approval-gate.test.mjs):
//   1. The PR body names its Slack thread:  slack-thread: <channel>/<ts>
//   2. The thread holds a "ready <sha>" post for the PR's current head commit,
//      from READY_POSTER when that is set.
//   3. After that post, an approver replied with an approval and did not later
//      reply with a hold. Approvers are listed Slack user IDs, or, when the list
//      is "*", any person who typed a message in the PR's thread (a public
//      channel's thread can only be posted to by channel members). App and bot
//      posts never count, so Claude cannot approve its own work either way.
//   4. The deploy window is open in WINDOW_TZ, or the approval says "now".
//
// Exit code 0 = merge allowed. Anything else = blocked, with the reason printed.

// Approval must be an explicit command. The message is split into clauses on
// punctuation and one clause must match COMMAND_RE in full; any question mark
// or negation anywhere in the message disqualifies it. "Looks good, ship it"
// approves; "I don't approve this", "approval pending" and "will this ship?"
// do not.
export const COMMAND_RE =
  /^(?:(?:ok|okay|yes|yep|yeah|please|sure|go ahead(?: and)?|looks good)\s+)?(approve|approved|ship|deploy|go live|merge|put (?:it|this) (?:in|into) production|roll ?back|revert|lgtm)(?:\s+(?:it|this|the pr|pr))?(?:\s+#?\d{1,6})?(?:\s+[0-9a-f]{7,40})?(?:\s+(now|immediately|right away|asap))?$/i;
export const NEGATION_RE =
  /\b(don'?t|do not|not|never|no|shouldn'?t|should not|can'?t|cannot|won'?t|isn'?t|aren'?t)\b/i;
export const HOLD_RE =
  /\b(hold|wait|not yet|stop|cancel|don'?t (?:ship|deploy|merge)|do not (?:ship|deploy|merge))\b/i;
export const NOW_RE = /\b(now|immediately|right away|asap|roll ?back|revert)\b/i;
export const READY_RE = /\bready\s+([0-9a-f]{7,40})\b/i;
export const THREAD_RE = /slack-thread:\s*([A-Z0-9]+)\/(\d+\.\d+)/;

/**
 * True when a message was posted through an app or bot rather than typed by
 * a person: Slack sets bot_id / app_id / bot_profile on such messages, and
 * the Claude Slack app also appends a "Sent using <@APP>" footer to the text
 * while attributing the message to the person's own user ID. Approvals must
 * come from a human-typed message; "ready" posts are expected to be app posts.
 */
export function isAppPost(m, readyPoster) {
  if (!m) return false;
  if (m.bot_id || m.app_id || m.bot_profile) return true;
  if (m.subtype === "bot_message") return true;
  const text = String(m.text ?? "");
  if (/sent using\s*<@[A-Z0-9]+/i.test(text)) return true;
  if (readyPoster && text.includes(`<@${readyPoster}`)) return true;
  return false;
}

// A "ready" post must come from Claude's Slack app. When READY_APP_ID is set,
// that is checked with the app_id Slack itself puts on the message, which a
// person's typed text cannot carry. The older check (user ID, or a mention of
// the app in the text) is only used when no app ID is configured, because a
// typed mention can be forged by anyone.
//
// The Claude app posts under the user ID of whoever ran Claude, so the app ID
// alone only proves "someone used the Claude app". READY_USERS names the
// people who legitimately drive Claude (the routine's owner, and anyone who
// mentions Claude in a thread); with it set, a ready post must also be
// attributed to one of them, so another workspace member using the Claude app
// cannot fake one.
function postedBy(m, readyPoster, readyAppId, readyUsers) {
  if (readyAppId) {
    return m.app_id === readyAppId && (!readyUsers?.length || readyUsers.includes(m.user));
  }
  if (!readyPoster) return true;
  if (m.user === readyPoster || m.bot_id === readyPoster || m.app_id === readyPoster) return true;
  return String(m.text ?? "").includes(`<@${readyPoster}`);
}

function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
    .replace(/<@[a-z0-9]+>/g, " ") // Slack user mentions
    .replace(/:[a-z0-9_+-]+:/g, " ") // :emoji:
    .replace(/[^\p{L}\p{N}\s#?'._-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Classifies one message from an approver.
 * @returns {"hold"|"approve"|"approve-now"|null}
 */
export function classifyApproverMessage(text) {
  const t = normalize(text);
  if (!t) return null;
  if (HOLD_RE.test(t)) return "hold";
  if (t.includes("?")) return null;
  if (NEGATION_RE.test(t)) return null;
  const clauses = t.split(/[.,;!\n]+/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const m = clause.match(COMMAND_RE);
    if (!m) continue;
    const verb = m[1];
    const now = Boolean(m[2]) || /roll ?back|revert/.test(verb);
    return now ? "approve-now" : "approve";
  }
  return null;
}

/**
 * True for a regular, active person of this workspace: not a bot, guest or
 * deactivated account, and (when teamId is given) a member of that workspace.
 * is_stranger alone does not catch Slack Connect users, so the team ID is
 * compared as well.
 */
export function isFullMember(user, teamId) {
  if (!user || !user.id) return false;
  if (user.deleted || user.is_bot || user.is_restricted || user.is_ultra_restricted || user.is_stranger) {
    return false;
  }
  if (teamId && user.team_id !== teamId) return false;
  return true;
}

/** The PR body names the thread; only this channel's threads count. Empty allowed = any. */
export function channelAllowed(ref, allowed) {
  if (!allowed) return true;
  return Boolean(ref) && ref.channel === allowed;
}

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
 * @param {string[]} p.approvers Slack user IDs, or ["*"] for any human who typed in the thread
 * @param {string} [p.readyPoster] Slack user ID that may post "ready"; empty = anyone
 * @param {string[]} [p.readyUsers] Slack user IDs the Claude app may post as (the people who drive Claude); a ready post must be attributed to one of them
 * @param {string[]} [p.eligibleUsers] with approvers ["*"]: Slack user IDs of full workspace members (required)
 * @param {string[]} [p.nowUsers] with approvers ["*"]: who may skip the deploy window with "approve now"
 * @param {string} [p.readyAppId] Slack app_id that must have posted "ready" (authenticates the post); required when approvers is "*"
 * @param {Date} p.now
 * @param {string} p.tz
 * @param {string} p.windowStart "HH:MM"
 * @param {string} p.windowEnd "HH:MM"
 */
export function decide(p) {
  const msgs = [...(p.messages ?? [])].sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
  const head = (p.headSha ?? "").toLowerCase();
  const approvers = new Set(p.approvers ?? []);
  const anyone = approvers.has("*");
  if (anyone && !p.readyAppId) {
    // With any person able to approve, "ready" posts must be authenticated.
    return { ok: false, reason: 'approvers "*" requires READY_APP_ID to authenticate ready posts' };
  }
  if (anyone && !p.eligibleUsers) {
    // ...and approvals must come from full members of the workspace, which the
    // caller looks up (users.info); with no list, nobody qualifies.
    return { ok: false, reason: 'approvers "*" requires the list of eligible workspace members' };
  }
  const eligible = new Set(p.eligibleUsers ?? []);
  // With "*", only these people may use "approve now" to skip the deploy
  // window; from anyone else it counts as a plain approval. Listed approvers
  // may always use it.
  const nowUsers = new Set(p.nowUsers ?? []);
  // With "*", a hold from one of these trusted people (NOW_USERS) can be lifted
  // only by a later approval from one of them; a stranger's approval cannot
  // clear it. With listed approvers everyone is trusted, as before.
  const trusted = (user) => (anyone ? nowUsers.has(user) : true);
  let trustedHold = false;

  // Latest "ready <sha>" for this head, from the ready poster (Claude's
  // Slack app) when one is configured.
  let ready = null;
  for (const m of msgs) {
    const match = (m.text ?? "").match(READY_RE);
    if (!match) continue;
    if (!postedBy(m, p.readyPoster, p.readyAppId, p.readyUsers)) continue;
    const sha = match[1].toLowerCase();
    if (!head.startsWith(sha)) continue;
    ready = m;
  }
  if (!ready) {
    return { ok: false, reason: `not ready: no "ready <sha>" post for ${head.slice(0, 7)}` };
  }

  // Approvals and holds after it, from approvers only.
  let approval = null;
  let override = false;
  for (const m of msgs) {
    if (tsNum(m.ts) <= tsNum(ready.ts)) continue;
    // A listed approver, or (with "*") a full member of the workspace.
    if (anyone ? !eligible.has(m.user) : !approvers.has(m.user)) continue;
    // Only a message the person typed themselves can approve. Posts made
    // through the Claude app carry the approver's user ID but are app posts.
    if (isAppPost(m, p.readyPoster)) continue;
    const verdict = classifyApproverMessage(m.text);
    if (verdict === "hold") {
      approval = null;
      override = false;
      if (trusted(m.user)) trustedHold = true;
    } else if (verdict === "approve" || verdict === "approve-now") {
      if (trustedHold && !trusted(m.user)) continue; // cannot lift a trusted person's hold
      approval = m;
      override = verdict === "approve-now" && (!anyone || nowUsers.has(m.user));
      if (trusted(m.user)) trustedHold = false;
    }
  }
  if (!approval) {
    return { ok: false, reason: `awaiting approval for ${head.slice(0, 7)}` };
  }

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

async function slackTeamId(token) {
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = await res.json();
  return j.ok ? j.team_id : null;
}

async function slackUser(token, id) {
  const url = new URL("https://slack.com/api/users.info");
  url.searchParams.set("user", id);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json();
  return j.ok ? j.user : null; // on any error the user is treated as ineligible
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
  if (!channelAllowed(ref, (env.ALLOWED_CHANNEL ?? "").trim())) {
    return block(`the PR's Slack thread is not in the allowed channel ${env.ALLOWED_CHANNEL}.`);
  }
  const messages = await slackReplies(env.SLACK_BOT_TOKEN, ref.channel, ref.ts);
  const readyPoster = (env.READY_POSTER ?? "").trim();
  const readyAppId = (env.READY_APP_ID ?? "").trim();
  const readyUsers = (env.READY_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const nowUsers = (env.NOW_USERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const approvers = (env.APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  console.log(
    approvers.includes("*")
      ? "approvers: any person who typed in the thread"
      : `approvers: ${approvers.join(",")}`
  );
  console.log(`ready posts must come from app_id ${readyAppId || "(not set)"}`);
  // Audit line per message: identity fields only, never the text.
  for (const m of messages) {
    console.log(
      `msg ts=${m.ts} user=${m.user ?? "-"} bot_id=${m.bot_id ?? "-"} app_id=${m.app_id ?? "-"} app_post=${isAppPost(m, readyPoster)} ready=${READY_RE.test(m.text ?? "")}`
    );
  }

  // With "*", look up everyone who typed in the thread and keep full members.
  let eligibleUsers;
  if (approvers.includes("*")) {
    const teamId = await slackTeamId(env.SLACK_BOT_TOKEN);
    if (!teamId) return block("could not determine the Slack workspace (auth.test failed).");
    eligibleUsers = [];
    const ids = [...new Set(messages.filter((m) => m.user && !isAppPost(m, readyPoster)).map((m) => m.user))];
    for (const id of ids) {
      const u = await slackUser(env.SLACK_BOT_TOKEN, id);
      const ok = isFullMember(u, teamId);
      console.log(`member ${id} eligible=${ok}`);
      if (ok) eligibleUsers.push(id);
    }
  }

  const verdict = decide({
    messages,
    headSha: env.HEAD_SHA,
    approvers,
    readyPoster,
    readyAppId,
    readyUsers,
    eligibleUsers,
    nowUsers,
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
