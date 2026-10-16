import { describe, expect, it } from "vitest";
import {
  classifyApproverMessage,
  decide,
  inDeployWindow,
  isAppPost,
  localMinutes,
  parseThreadRef,
} from "./slack-approval-gate.mjs";

const DANIEL = "U2QG6THFA";
const KILLIAN = "U04T8JF0G0P";
const CLAUDE = "UCLAUDE";
const HEAD = "6f6640e66bde68254e6e4014b22297388a3fc4ef";

// 2026-10-16 04:00 UTC = 2026-10-16 00:00 EDT (inside window)
const IN_WINDOW = new Date("2026-10-16T04:00:00Z");
// 2026-10-16 18:00 UTC = 14:00 EDT (outside window)
const OUT_WINDOW = new Date("2026-10-16T18:00:00Z");

function base(extra = {}) {
  return {
    headSha: HEAD,
    approvers: [DANIEL, KILLIAN],
    readyPoster: CLAUDE,
    now: IN_WINDOW,
    tz: "America/New_York",
    windowStart: "23:30",
    windowEnd: "06:00",
    ...extra,
  };
}

const ready = { user: CLAUDE, text: "ready 6f6640e\nWhat changed: ...", ts: "100.000" };
// How the Claude Slack app actually posts: the user's own ID, plus a footer.
const APP = "UAPPCLAUDE";
const readyViaApp = {
  user: DANIEL,
  text: `ready 6f6640e\nWhat changed: ...\n*Sent using* <@${APP}|Claude>`,
  ts: "100.000",
};

describe("parseThreadRef", () => {
  it("extracts channel and ts", () => {
    expect(parseThreadRef("x\nslack-thread: C0C9HLJ9H3Q/1760000000.000100\ny")).toEqual({
      channel: "C0C9HLJ9H3Q",
      ts: "1760000000.000100",
    });
    expect(parseThreadRef("nothing")).toBeNull();
  });
});

describe("classifyApproverMessage", () => {
  it("accepts explicit commands, with or without pleasantries", () => {
    for (const t of [
      "approve",
      "Approve!",
      "approved",
      "ship it",
      "Looks good, ship it",
      "yes approve 7efdc10",
      "ok deploy",
      "go live",
      "merge it",
      "LGTM",
      "approve #29",
      "please approve this",
    ]) {
      expect(classifyApproverMessage(t), t).toBe("approve");
    }
  });

  it("recognizes the window override", () => {
    for (const t of ["approve now", "ship it immediately", "approve 7efdc10 now", "roll back", "revert"]) {
      expect(classifyApproverMessage(t), t).toBe("approve-now");
    }
  });

  it("rejects negations, questions and conversational mentions", () => {
    for (const t of [
      "I don't approve this",
      "this is not approved",
      "approval pending",
      "will this ship?",
      "should we deploy?",
      "approve?",
      "I never said approve",
      "we can't ship this yet",
      "thinking about whether to approve",
      "the approve button",
      "deploy window is tonight",
      "",
    ]) {
      expect(classifyApproverMessage(t), t).toBeNull();
    }
  });

  it("recognizes holds", () => {
    for (const t of ["hold", "hold on, I want to check something", "wait", "don't ship", "cancel that"]) {
      expect(classifyApproverMessage(t), t).toBe("hold");
    }
  });
});

describe("isAppPost", () => {
  it("detects bot fields, the Sent-using footer, and the app mention", () => {
    expect(isAppPost({ user: DANIEL, text: "approve" }, APP)).toBe(false);
    expect(isAppPost({ user: DANIEL, text: "approve", bot_id: "B1" }, APP)).toBe(true);
    expect(isAppPost({ user: DANIEL, text: "approve", app_id: "A1" }, APP)).toBe(true);
    expect(isAppPost(readyViaApp, APP)).toBe(true);
    expect(isAppPost({ user: DANIEL, text: `approve now <@${APP}>` }, APP)).toBe(true);
  });
});

describe("decide with Claude-app attribution", () => {
  it("accepts a ready post attributed to an approver when it carries the app footer", () => {
    const v = decide(
      base({
        readyPoster: APP,
        messages: [readyViaApp, { user: DANIEL, text: "approve now", ts: "101.0" }],
      })
    );
    expect(v.ok).toBe(true);
  });

  it("ignores an approval that came through the app, even from an approver", () => {
    const v = decide(
      base({
        readyPoster: APP,
        messages: [
          readyViaApp,
          { user: DANIEL, text: `approve now\n*Sent using* <@${APP}|Claude>`, ts: "101.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("ignores a ready post without the app footer when a ready poster is set", () => {
    const v = decide(
      base({
        readyPoster: APP,
        messages: [
          { user: DANIEL, text: "ready 6f6640e", ts: "100.0" },
          { user: DANIEL, text: "approve now", ts: "101.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });
});

describe("deploy window", () => {
  it("computes local minutes in the zone", () => {
    expect(localMinutes(IN_WINDOW, "America/New_York")).toBe(0);
    expect(localMinutes(OUT_WINDOW, "America/New_York")).toBe(14 * 60);
  });

  it("handles a window that crosses midnight", () => {
    expect(inDeployWindow(IN_WINDOW, "America/New_York", "23:30", "06:00")).toBe(true);
    expect(inDeployWindow(OUT_WINDOW, "America/New_York", "23:30", "06:00")).toBe(false);
    // 23:45 EDT = 03:45 UTC next day
    expect(inDeployWindow(new Date("2026-10-16T03:45:00Z"), "America/New_York", "23:30", "06:00")).toBe(true);
    // 06:00 EDT exactly is outside (end is exclusive)
    expect(inDeployWindow(new Date("2026-10-16T10:00:00Z"), "America/New_York", "23:30", "06:00")).toBe(false);
  });
});

describe("decide", () => {
  it("blocks when there is no ready post", () => {
    const v = decide(base({ messages: [{ user: DANIEL, text: "approve", ts: "1.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });

  it("blocks when ready names a different sha", () => {
    const v = decide(
      base({
        messages: [
          { user: CLAUDE, text: "ready abcdef1", ts: "100.0" },
          { user: DANIEL, text: "approve now", ts: "101.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });

  it("ignores ready posts from anyone but the ready poster when set", () => {
    const v = decide(
      base({
        messages: [
          { user: "UIMPOSTOR", text: "ready 6f6640e", ts: "100.0" },
          { user: DANIEL, text: "approve now", ts: "101.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
  });

  it("accepts ready from anyone when readyPoster is empty (bootstrap)", () => {
    const v = decide(
      base({
        readyPoster: "",
        messages: [
          { user: "UANY", text: "ready 6f6640e", ts: "100.0" },
          { user: DANIEL, text: "approve now", ts: "101.0" },
        ],
      })
    );
    expect(v.ok).toBe(true);
  });

  it("blocks when only a non-approver approves", () => {
    const v = decide(
      base({
        messages: [ready, { user: "UOTHER", text: "approve now", ts: "101.0" }],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("blocks when the approval came before the ready post", () => {
    const v = decide(
      base({
        messages: [{ user: DANIEL, text: "approve now", ts: "99.0" }, ready],
      })
    );
    expect(v.ok).toBe(false);
  });

  it("passes inside the window with a plain approval", () => {
    const v = decide(
      base({
        messages: [ready, { user: KILLIAN, text: "Looks good, ship it", ts: "101.0" }],
      })
    );
    expect(v.ok).toBe(true);
    expect(v.reason).toContain(KILLIAN);
  });

  it("waits for the window without an override", () => {
    const v = decide(
      base({
        now: OUT_WINDOW,
        messages: [ready, { user: DANIEL, text: "approve", ts: "101.0" }],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/waiting for deploy window/);
  });

  it("passes outside the window with 'now'", () => {
    const v = decide(
      base({
        now: OUT_WINDOW,
        messages: [ready, { user: DANIEL, text: "approve now", ts: "101.0" }],
      })
    );
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/override/);
  });

  it("treats roll back as approval with override", () => {
    const v = decide(
      base({
        now: OUT_WINDOW,
        messages: [ready, { user: DANIEL, text: "roll back", ts: "101.0" }],
      })
    );
    expect(v.ok).toBe(true);
  });

  it("a later hold withdraws the approval", () => {
    const v = decide(
      base({
        messages: [
          ready,
          { user: DANIEL, text: "approve", ts: "101.0" },
          { user: KILLIAN, text: "hold, I want to check something", ts: "102.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("an approval after a hold counts again", () => {
    const v = decide(
      base({
        messages: [
          ready,
          { user: DANIEL, text: "approve", ts: "101.0" },
          { user: DANIEL, text: "wait", ts: "102.0" },
          { user: DANIEL, text: "ok approve", ts: "103.0" },
        ],
      })
    );
    expect(v.ok).toBe(true);
  });

  it("a new push needs a new ready: old ready for old sha does not count", () => {
    const v = decide(
      base({
        headSha: "abcdef1234567890abcdef1234567890abcdef12",
        messages: [ready, { user: DANIEL, text: "approve now", ts: "101.0" }],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });

  it("uses the latest ready post when several exist", () => {
    const v = decide(
      base({
        messages: [
          { user: CLAUDE, text: "ready 6f6640e", ts: "100.0" },
          { user: DANIEL, text: "approve now", ts: "101.0" },
          { user: CLAUDE, text: "ready 6f6640e (re-posted after rebase)", ts: "102.0" },
        ],
      })
    );
    // approval predates the latest ready post for this sha
    expect(v.ok).toBe(false);
  });
});

describe('decide with approvers set to "*" (any person who typed in the thread)', () => {
  // Wildcard mode needs an authenticated ready post, as the real workflow has.
  const APP_ID = "A08SF47R6P4";
  const ready = { user: DANIEL, app_id: APP_ID, text: "ready 6f6640e\nWhat changed: ...", ts: "100.000" };
  const anyone = (extra = {}) => base({ approvers: ["*"], readyAppId: APP_ID, ...extra });

  it("accepts a typed approval from someone who is not a listed approver", () => {
    const v = decide(anyone({ messages: [ready, { user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/UOTHER/);
  });

  it("still ignores an approval posted through the Claude app, whoever's ID it carries", () => {
    const viaApp = {
      user: "UOTHER",
      text: `approve now\n*Sent using* <@${APP}|Claude>`,
      ts: "101.0",
    };
    const v = decide(anyone({ messages: [ready, viaApp] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("still ignores bot posts and messages with no user", () => {
    const v = decide(
      anyone({
        messages: [
          ready,
          { user: "UBOT", bot_id: "B1", text: "approve now", ts: "101.0" },
          { subtype: "channel_join", text: "approve now", ts: "102.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
  });

  it("a hold from anyone withdraws an earlier approval", () => {
    const v = decide(
      anyone({
        messages: [
          ready,
          { user: DANIEL, text: "approve now", ts: "101.0" },
          { user: "UOTHER", text: "hold on, not yet", ts: "102.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("still needs a ready post for the current head and still honors the window", () => {
    const noReady = decide(anyone({ messages: [{ user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(noReady.ok).toBe(false);
    expect(noReady.reason).toMatch(/not ready/);

    const outside = decide(
      anyone({
        now: OUT_WINDOW,
        messages: [ready, { user: "UOTHER", text: "approve", ts: "101.0" }],
      })
    );
    expect(outside.ok).toBe(false);
    expect(outside.reason).toMatch(/deploy window/);
  });

  it("with a listed approver set, a stranger's approval still does not count", () => {
    const v = decide(base({ messages: [ready, { user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
  });
});

describe("authenticating ready posts with the Slack app ID", () => {
  const APP_ID = "A08SF47R6P4";
  // How Slack delivers a post made through the Claude app: the person's user
  // ID, plus the app's app_id, which typed text cannot carry.
  const realReady = { user: DANIEL, app_id: APP_ID, text: "ready 6f6640e\nWhat changed: ...", ts: "100.000" };
  const withApp = (extra = {}) => base({ approvers: ["*"], readyAppId: APP_ID, ...extra });

  it("refuses to run in wildcard mode without an app ID", () => {
    const v = decide(base({ approvers: ["*"], messages: [realReady, { user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/READY_APP_ID/);
  });

  it("accepts a real ready post and a stranger's typed approval", () => {
    const v = decide(withApp({ messages: [realReady, { user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(true);
  });

  it("rejects a ready post forged by typing the app mention", () => {
    const forged = { user: "UOTHER", text: `ready 6f6640e <@${CLAUDE}> <@${APP}>`, ts: "100.000" };
    const v = decide(
      withApp({ readyPoster: CLAUDE, messages: [forged, { user: "UOTHER", text: "approve now", ts: "101.0" }] })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });

  it("rejects a ready post forged with the Sent-using footer", () => {
    const forged = { user: "UOTHER", text: `ready 6f6640e\n*Sent using* <@${APP}|Claude>`, ts: "100.000" };
    const v = decide(withApp({ messages: [forged, { user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });

  it("rejects a ready post from a different app", () => {
    const other = { user: DANIEL, app_id: "AOTHERAPP", text: "ready 6f6640e", ts: "100.000" };
    const v = decide(withApp({ messages: [other, { user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
  });

  it("also tightens listed-approver mode when an app ID is set", () => {
    const forged = { user: DANIEL, text: `ready 6f6640e <@${CLAUDE}>`, ts: "100.000" };
    const v = decide(base({ readyAppId: APP_ID, messages: [forged, { user: KILLIAN, text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });
});
