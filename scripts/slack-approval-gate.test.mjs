import { describe, expect, it } from "vitest";
import {
  channelAllowed,
  classifyApproverMessage,
  decide,
  inDeployWindow,
  isAppPost,
  isFullMember,
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
  const anyone = (extra = {}) =>
    base({
      approvers: ["*"],
      readyAppId: APP_ID,
      readyUsers: [DANIEL, KILLIAN],
      eligibleUsers: [DANIEL, KILLIAN, "UOTHER"],
      nowUsers: [DANIEL, KILLIAN],
      ...extra,
    });

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
  const withApp = (extra = {}) =>
    base({
      approvers: ["*"],
      readyAppId: APP_ID,
      readyUsers: [DANIEL, KILLIAN],
      eligibleUsers: [DANIEL, KILLIAN, "UOTHER"],
      nowUsers: [DANIEL, KILLIAN],
      ...extra,
    });

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

describe('guardrails on "*" mode', () => {
  const APP_ID = "A08SF47R6P4";
  // The real shape of a ready post, from the gate's own log: the routine's
  // user ID, the app_id, and the app footer in the text.
  const realReady = {
    user: DANIEL,
    app_id: APP_ID,
    text: `ready 6f6640e\nWhat changed: ...\n*Sent using* <@${APP}|Claude>`,
    ts: "100.000",
  };
  const cfg = (extra = {}) =>
    base({
      approvers: ["*"],
      readyAppId: APP_ID,
      readyUsers: [DANIEL, KILLIAN],
      eligibleUsers: [DANIEL, KILLIAN, "UOTHER"],
      nowUsers: [DANIEL, KILLIAN],
      ...extra,
    });

  it("accepts the real ready post shape (user + app_id + footer)", () => {
    const v = decide(cfg({ messages: [realReady, { user: "UOTHER", text: "approve", ts: "101.0" }] }));
    expect(v.ok).toBe(true);
  });

  it("rejects a ready post made through the Claude app by a different person", () => {
    const byOther = { ...realReady, user: "UOTHER" };
    const v = decide(cfg({ messages: [byOther, { user: "UOTHER", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not ready/);
  });

  it("ignores an approval from someone who is not a full workspace member", () => {
    const v = decide(cfg({ messages: [realReady, { user: "UGUEST", text: "approve now", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("refuses to run without the list of eligible members", () => {
    const v = decide(cfg({ eligibleUsers: undefined, messages: [realReady, { user: "UOTHER", text: "approve", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/eligible/);
  });

  it('"approve now" from a stranger does not skip the deploy window', () => {
    const msgs = [realReady, { user: "UOTHER", text: "approve now", ts: "101.0" }];
    const outside = decide(cfg({ now: OUT_WINDOW, messages: msgs }));
    expect(outside.ok).toBe(false);
    expect(outside.reason).toMatch(/deploy window/);
    const inside = decide(cfg({ now: IN_WINDOW, messages: msgs }));
    expect(inside.ok).toBe(true);
  });

  it('"approve now" from Daniel or Killian still skips the window', () => {
    for (const who of [DANIEL, KILLIAN]) {
      const v = decide(cfg({ now: OUT_WINDOW, messages: [realReady, { user: who, text: "approve now", ts: "101.0" }] }));
      expect(v.ok).toBe(true);
      expect(v.reason).toMatch(/window override/);
    }
  });

  it('"roll back" from a stranger is a plain approval, not an override', () => {
    const v = decide(cfg({ now: OUT_WINDOW, messages: [realReady, { user: "UOTHER", text: "roll back", ts: "101.0" }] }));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/deploy window/);
  });
});

describe("isFullMember", () => {
  it("accepts a regular person", () => {
    expect(isFullMember({ id: "U1", name: "a" })).toBe(true);
  });
  it("rejects bots, guests, deactivated and external accounts, and missing users", () => {
    expect(isFullMember({ id: "U1", is_bot: true })).toBe(false);
    expect(isFullMember({ id: "U1", is_restricted: true })).toBe(false);
    expect(isFullMember({ id: "U1", is_ultra_restricted: true })).toBe(false);
    expect(isFullMember({ id: "U1", is_stranger: true })).toBe(false);
    expect(isFullMember({ id: "U1", deleted: true })).toBe(false);
    expect(isFullMember(null)).toBe(false);
  });
});

describe("channelAllowed", () => {
  it("accepts only the named channel when one is set", () => {
    expect(channelAllowed({ channel: "C0C9HLJ9H3Q", ts: "1.0" }, "C0C9HLJ9H3Q")).toBe(true);
    expect(channelAllowed({ channel: "COTHER", ts: "1.0" }, "C0C9HLJ9H3Q")).toBe(false);
    expect(channelAllowed(null, "C0C9HLJ9H3Q")).toBe(false);
    expect(channelAllowed({ channel: "COTHER", ts: "1.0" }, "")).toBe(true);
  });
});

describe("holds and ready posts in \"*\" mode", () => {
  const APP_ID = "A08SF47R6P4";
  const realReady = { user: DANIEL, app_id: APP_ID, text: "ready 6f6640e\nWhat changed: ...", ts: "100.000" };
  const cfg = (extra = {}) =>
    base({
      approvers: ["*"],
      readyAppId: APP_ID,
      readyUsers: [DANIEL, KILLIAN],
      eligibleUsers: [DANIEL, KILLIAN, "UOTHER", "UOTHER2"],
      nowUsers: [DANIEL, KILLIAN],
      ...extra,
    });

  it("a stranger's approval cannot lift a hold from Daniel", () => {
    const v = decide(
      cfg({
        messages: [
          realReady,
          { user: DANIEL, text: "hold, I want to check something", ts: "101.0" },
          { user: "UOTHER", text: "approve", ts: "102.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("Daniel's or Killian's later approval does lift their hold", () => {
    for (const who of [DANIEL, KILLIAN]) {
      const v = decide(
        cfg({
          messages: [
            realReady,
            { user: DANIEL, text: "hold", ts: "101.0" },
            { user: "UOTHER", text: "approve", ts: "102.0" },
            { user: who, text: "approve", ts: "103.0" },
          ],
        })
      );
      expect(v.ok).toBe(true);
    }
  });

  it("a stranger's own hold can be lifted by any approval", () => {
    const v = decide(
      cfg({
        messages: [
          realReady,
          { user: "UOTHER", text: "hold on", ts: "101.0" },
          { user: "UOTHER2", text: "approve", ts: "102.0" },
        ],
      })
    );
    expect(v.ok).toBe(true);
  });

  it("a stranger's hold after Daniel's hold does not make Daniel's hold removable by strangers", () => {
    const v = decide(
      cfg({
        messages: [
          realReady,
          { user: DANIEL, text: "hold", ts: "101.0" },
          { user: "UOTHER", text: "wait", ts: "102.0" },
          { user: "UOTHER2", text: "approve", ts: "103.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
  });

  it("accepts a ready post made through the Claude app by Killian, and rejects a third person's", () => {
    const byKillian = { ...realReady, user: KILLIAN };
    const ok = decide(cfg({ messages: [byKillian, { user: "UOTHER", text: "approve", ts: "101.0" }] }));
    expect(ok.ok).toBe(true);
    const byOther = { ...realReady, user: "UOTHER" };
    const bad = decide(cfg({ messages: [byOther, { user: "UOTHER2", text: "approve", ts: "101.0" }] }));
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/not ready/);
  });

  it("with listed approvers a hold from any of them is lifted by any of them, as before", () => {
    const v = decide(
      base({
        messages: [
          ready,
          { user: DANIEL, text: "hold", ts: "101.0" },
          { user: KILLIAN, text: "approve", ts: "102.0" },
        ],
      })
    );
    expect(v.ok).toBe(true);
  });
});

describe("isFullMember with the workspace team ID", () => {
  const me = { id: "U1", team_id: "T_ME" };
  it("accepts a member of this workspace", () => {
    expect(isFullMember(me, "T_ME")).toBe(true);
  });
  it("rejects a Slack Connect user from another workspace, and a user with no team ID", () => {
    expect(isFullMember({ id: "U2", team_id: "T_OTHER" }, "T_ME")).toBe(false);
    expect(isFullMember({ id: "U3" }, "T_ME")).toBe(false);
  });
  it("without a team ID only the other checks apply", () => {
    expect(isFullMember({ id: "U2", team_id: "T_OTHER" })).toBe(true);
    expect(isFullMember({ id: "U2", team_id: "T_OTHER", is_restricted: true })).toBe(false);
  });
});

describe("a trusted hold survives a new ready post", () => {
  const APP_ID = "A08SF47R6P4";
  const readyAt = (ts) => ({ user: DANIEL, app_id: APP_ID, text: "ready 6f6640e\nWhat changed: ...", ts });
  const cfg = (extra = {}) =>
    base({
      approvers: ["*"],
      readyAppId: APP_ID,
      readyUsers: [DANIEL, KILLIAN],
      eligibleUsers: [DANIEL, KILLIAN, "UOTHER"],
      nowUsers: [DANIEL, KILLIAN],
      ...extra,
    });

  it("a stranger cannot approve over Daniel's hold after the routine posts a fresh ready", () => {
    const v = decide(
      cfg({
        messages: [
          readyAt("100.0"),
          { user: DANIEL, text: "hold, I want to check something", ts: "101.0" },
          readyAt("102.0"), // new push, new ready
          { user: "UOTHER", text: "approve", ts: "103.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/awaiting approval/);
  });

  it("Daniel or Killian approving after the fresh ready does lift it", () => {
    for (const who of [DANIEL, KILLIAN]) {
      const v = decide(
        cfg({
          messages: [
            readyAt("100.0"),
            { user: DANIEL, text: "hold", ts: "101.0" },
            readyAt("102.0"),
            { user: who, text: "approve", ts: "103.0" },
          ],
        })
      );
      expect(v.ok).toBe(true);
    }
  });

  it("a hold Daniel already lifted with his own approval before the new ready does not block", () => {
    const v = decide(
      cfg({
        messages: [
          readyAt("100.0"),
          { user: DANIEL, text: "hold", ts: "101.0" },
          { user: DANIEL, text: "approve", ts: "102.0" },
          readyAt("103.0"),
          { user: "UOTHER", text: "approve", ts: "104.0" },
        ],
      })
    );
    expect(v.ok).toBe(true);
  });

  it("a failed member lookup for Daniel does not drop his hold", () => {
    const v = decide(
      cfg({
        eligibleUsers: ["UOTHER"], // Daniel missing: lookup failed
        messages: [
          readyAt("100.0"),
          { user: DANIEL, text: "hold", ts: "101.0" },
          { user: "UOTHER", text: "approve", ts: "102.0" },
        ],
      })
    );
    expect(v.ok).toBe(false);
  });

  it("the routine's own app posts that contain hold words are not holds", () => {
    const appPost = {
      user: DANIEL,
      app_id: APP_ID,
      text: "Please hold off on approving until CI is green\n*Sent using* <@" + APP + "|Claude>",
      ts: "101.0",
    };
    const v = decide(cfg({ messages: [readyAt("100.0"), appPost, readyAt("102.0"), { user: "UOTHER", text: "approve", ts: "103.0" }] }));
    expect(v.ok).toBe(true);
  });

  it("a stranger's earlier hold does not carry over", () => {
    const v = decide(
      cfg({
        messages: [
          readyAt("100.0"),
          { user: "UOTHER", text: "hold on", ts: "101.0" },
          readyAt("102.0"),
          { user: "UOTHER", text: "approve", ts: "103.0" },
        ],
      })
    );
    expect(v.ok).toBe(true);
  });
});
