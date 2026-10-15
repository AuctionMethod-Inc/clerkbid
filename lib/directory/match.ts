/** Shared matching helpers for the org-wide bidder/consignor directory. */

export function digitsOnly(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

export function normalizeEmail(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function optTrim(value: string | undefined | null): string | undefined {
  const t = (value ?? "").trim();
  return t || undefined;
}

/** True when `query` is (or contains) the last 4 digits of `phone`. */
export function matchesPhoneLast4(
  phone: string | undefined,
  query: string
): boolean {
  const qDigits = digitsOnly(query);
  if (qDigits.length < 4) return false;
  const p = digitsOnly(phone);
  if (p.length < 4) return false;
  const last4 = p.slice(-4);
  if (qDigits.length === 4) return last4 === qDigits;
  return p.includes(qDigits) || last4 === qDigits.slice(-4);
}

export function nameBlob(
  firstName: string | undefined,
  lastName: string | undefined
): string {
  return `${firstName ?? ""} ${lastName ?? ""}`.trim().toLowerCase();
}

export function matchesNameQuery(
  firstName: string | undefined,
  lastName: string | undefined,
  query: string
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const first = (firstName ?? "").trim().toLowerCase();
  const last = (lastName ?? "").trim().toLowerCase();
  if (first.includes(q) || last.includes(q)) return true;
  return nameBlob(firstName, lastName).includes(q);
}

export function matchesSingleNameQuery(name: string | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const n = (name ?? "").trim().toLowerCase();
  if (n.includes(q)) return true;
  const tokens = n.split(/\s+/).filter(Boolean);
  return tokens.some((t) => t.includes(q) || q.includes(t));
}
