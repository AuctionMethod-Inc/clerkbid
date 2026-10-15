import { describe, expect, it } from "vitest";
import {
  eventRosterNumberTakenByAnother,
  rosterNumberChanged,
} from "@/lib/roster/eventNumberConflict";

describe("rosterNumberChanged", () => {
  it("is false when the paddle is unchanged", () => {
    expect(rosterNumberChanged(12, 12)).toBe(false);
  });

  it("is true when assigning a number on create", () => {
    expect(rosterNumberChanged(undefined, 12)).toBe(true);
  });
});

describe("eventRosterNumberTakenByAnother", () => {
  const rows = [
    { id: 1, number: 10 },
    { id: 2, number: 11 },
  ];

  it("allows saving the same paddle on the row being edited", () => {
    expect(eventRosterNumberTakenByAnother(rows, 10, 1)).toBe(false);
  });

  it("blocks a paddle owned by a different row", () => {
    expect(eventRosterNumberTakenByAnother(rows, 10, 2)).toBe(true);
  });

  it("blocks a taken paddle on create", () => {
    expect(eventRosterNumberTakenByAnother(rows, 10, undefined)).toBe(true);
  });

  it("allows an unused paddle", () => {
    expect(eventRosterNumberTakenByAnother(rows, 99, 1)).toBe(false);
  });

  it("does not treat a duplicate paddle as blocking when editing one of those rows if we skip via unchanged number", () => {
    const dupes = [
      { id: 1, number: 5 },
      { id: 2, number: 5 },
    ];
    expect(eventRosterNumberTakenByAnother(dupes, 5, 2)).toBe(true);
    expect(rosterNumberChanged(5, 5)).toBe(false);
  });
});
