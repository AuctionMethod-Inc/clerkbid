/** True when another event row already holds this roster number (paddle / consignor #). */
export function eventRosterNumberTakenByAnother(
  rows: Array<{ id?: number; number: number }>,
  nextNumber: number,
  editingId?: number
): boolean {
  return rows.some(
    (r) =>
      r.number === nextNumber &&
      (editingId == null || r.id !== editingId)
  );
}

/**
 * Skip uniqueness when the clerk is not changing the number.
 * Avoids false "already registered" on address/resale edits if the compound
 * index returns this row (or a duplicate) under a different id than `editing`.
 */
export function rosterNumberChanged(
  originalNumber: number | undefined,
  nextNumber: number
): boolean {
  return originalNumber !== nextNumber;
}
