import { describe, expect, it } from "vitest";
import {
  hasUnpushedLocalEventMetadataEdits,
  isServerSnapshotNewerThanLocalBaseline,
  shouldBlockAutoSnapshotReplace,
} from "@/lib/services/cloudSync";

describe("isServerSnapshotNewerThanLocalBaseline", () => {
  it("returns false for invalid server time", () => {
    expect(
      isServerSnapshotNewerThanLocalBaseline("not-a-date", undefined, undefined)
    ).toBe(false);
  });

  it("when lastCloudPullAt is set, compares only to that (strict newer)", () => {
    const pull = new Date("2026-01-01T12:00:00.000Z");
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T11:59:59.999Z",
        pull,
        undefined
      )
    ).toBe(false);
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T12:00:00.000Z",
        pull,
        undefined
      )
    ).toBe(false);
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T12:00:00.001Z",
        pull,
        undefined
      )
    ).toBe(true);
  });

  it("uses the later of pull and push so a just-pushed snapshot is not newer", () => {
    const pull = new Date("2026-01-01T12:00:00.000Z");
    const push = new Date("2026-01-01T12:00:01.000Z");
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T12:00:01.000Z",
        pull,
        push
      )
    ).toBe(false);
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T12:00:01.001Z",
        pull,
        push
      )
    ).toBe(true);
  });

  it("when never pulled, uses lastCloudPushAt so equal server time is not newer", () => {
    const push = new Date("2026-01-01T12:00:00.000Z");
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T12:00:00.000Z",
        undefined,
        push
      )
    ).toBe(false);
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T12:00:00.001Z",
        undefined,
        push
      )
    ).toBe(true);
  });

  it("when neither pull nor push baseline, does not treat server as newer", () => {
    expect(
      isServerSnapshotNewerThanLocalBaseline(
        "2026-01-01T12:00:00.000Z",
        undefined,
        undefined
      )
    ).toBe(false);
  });
});

describe("hasUnpushedLocalEventMetadataEdits", () => {
  it("is false when there is no push or pull baseline to compare", () => {
    expect(
      hasUnpushedLocalEventMetadataEdits({
        updatedAt: new Date("2026-01-02T12:00:00.000Z"),
      })
    ).toBe(false);
  });

  it("is true when never snapshot-pushed but local row changed after last pull", () => {
    expect(
      hasUnpushedLocalEventMetadataEdits({
        updatedAt: new Date("2026-01-02T12:00:00.000Z"),
        lastCloudPullAt: new Date("2026-01-01T12:00:00.000Z"),
      })
    ).toBe(true);
  });

  it("is false when updatedAt matches last pull (aligned after server refresh)", () => {
    const t = new Date("2026-01-01T12:00:00.000Z");
    expect(
      hasUnpushedLocalEventMetadataEdits({
        updatedAt: t,
        lastCloudPullAt: t,
      })
    ).toBe(false);
  });

  it("is false when updatedAt is not after last push", () => {
    const t = new Date("2026-01-01T12:00:00.000Z");
    expect(
      hasUnpushedLocalEventMetadataEdits({
        updatedAt: t,
        lastCloudPushAt: t,
      })
    ).toBe(false);
    expect(
      hasUnpushedLocalEventMetadataEdits({
        updatedAt: new Date("2026-01-01T11:00:00.000Z"),
        lastCloudPushAt: t,
      })
    ).toBe(false);
  });

  it("is true when event row was saved after last successful push", () => {
    expect(
      hasUnpushedLocalEventMetadataEdits({
        updatedAt: new Date("2026-01-02T12:00:00.000Z"),
        lastCloudPushAt: new Date("2026-01-01T12:00:00.000Z"),
      })
    ).toBe(true);
  });
});

describe("shouldBlockAutoSnapshotReplace", () => {
  it("blocks when op sync is on and outbox has rows", () => {
    expect(shouldBlockAutoSnapshotReplace(true, 1)).toBe(true);
    expect(shouldBlockAutoSnapshotReplace(true, 3)).toBe(true);
  });

  it("allows when op sync is off", () => {
    expect(shouldBlockAutoSnapshotReplace(false, 99)).toBe(false);
  });

  it("allows when outbox is empty", () => {
    expect(shouldBlockAutoSnapshotReplace(true, 0)).toBe(false);
  });
});
