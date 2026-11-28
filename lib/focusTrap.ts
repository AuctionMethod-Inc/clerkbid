const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The focusable elements inside `container`, in tab order. */
export function focusableIn(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/**
 * Keeps Tab and Shift+Tab inside a modal: wraps from the last control to the
 * first and back, and pulls focus back in if it has left the container.
 */
export function trapTab(
  e: Pick<KeyboardEvent, "shiftKey" | "preventDefault">,
  container: HTMLElement | null,
  active: Element | null = typeof document !== "undefined"
    ? document.activeElement
    : null,
): void {
  if (!container) return;
  const items = focusableIn(container);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const inside = active != null && container.contains(active);
  if (e.shiftKey) {
    if (!inside || active === first) {
      e.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    e.preventDefault();
    first.focus();
  }
}
