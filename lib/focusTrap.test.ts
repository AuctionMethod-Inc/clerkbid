import { describe, expect, it, vi } from "vitest";
import { trapTab } from "./focusTrap";

function fakeEl() {
  return { focus: vi.fn() } as unknown as HTMLElement & {
    focus: ReturnType<typeof vi.fn>;
  };
}

function fakeContainer(items: HTMLElement[]) {
  return {
    querySelectorAll: () => items,
    contains: (el: unknown) => items.includes(el as HTMLElement),
  } as unknown as HTMLElement;
}

function tab(shiftKey = false) {
  return { shiftKey, preventDefault: vi.fn() };
}

describe("trapTab", () => {
  const a = fakeEl();
  const b = fakeEl();
  const c = fakeEl();
  const box = fakeContainer([a, b, c]);

  it("wraps Tab from the last control to the first", () => {
    const e = tab();
    trapTab(e, box, c);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(a.focus).toHaveBeenCalled();
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const e = tab(true);
    trapTab(e, box, a);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(c.focus).toHaveBeenCalled();
  });

  it("leaves Tab alone between controls inside", () => {
    const e = tab();
    trapTab(e, box, b);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("pulls focus back in when it is outside the container", () => {
    const outside = fakeEl();
    a.focus.mockClear();
    const e = tab();
    trapTab(e, box, outside);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(a.focus).toHaveBeenCalled();
  });

  it("blocks Tab when the container has nothing focusable", () => {
    const e = tab();
    trapTab(e, fakeContainer([]), null);
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
