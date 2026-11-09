import type { JWT } from "next-auth/jwt";
import type { Session } from "next-auth";

/** Lowercase emails with full /admin access (user id 1 is always included). */
const SUPER_ADMIN_EMAILS: ReadonlySet<string> = new Set([
  "daniel@auctionmethod.com",
  "killian@auctionmethod.com",
]);

export function isSuperAdminUserIdAndEmail(
  userId: string | number | undefined | null,
  email: string | null | undefined
): boolean {
  const id = typeof userId === "string" ? parseInt(userId, 10) : Number(userId);
  if (id === 1) return true;
  const e = email?.trim().toLowerCase();
  return e ? SUPER_ADMIN_EMAILS.has(e) : false;
}

/** True when JWT subject (logged-in user) is the super admin. */
export function isSuperAdminJwt(token: JWT | null | undefined): boolean {
  if (!token?.sub) return false;
  return isSuperAdminUserIdAndEmail(
    token.sub,
    typeof token.email === "string" ? token.email : null
  );
}

/** Super admin may access /admin; block while impersonating another user. */
export function canAccessAdminArea(token: JWT | null | undefined): boolean {
  if (!token?.sub) return false;
  if (token.impersonatedBy) return false;
  return isSuperAdminJwt(token);
}

/**
 * Revert-to-admin API: only valid while JWT has impersonatedBy (proves an admin
 * started this session). Must be allowed through middleware separately from
 * {@link canAccessAdminArea}.
 */
export function canAccessAdminRevertApi(token: JWT | null | undefined): boolean {
  return Boolean(token?.sub && token.impersonatedBy);
}

export function isSuperAdminSession(session: Session | null): boolean {
  if (!session?.user) return false;
  return isSuperAdminUserIdAndEmail(session.user.id, session.user.email);
}

export function isSuperAdminUserRow(user: {
  id: number;
  email: string;
}): boolean {
  return isSuperAdminUserIdAndEmail(user.id, user.email);
}

/** Session is "acting as" another user (super admin assist). */
export function isImpersonatingSession(session: Session | null): boolean {
  return Boolean(session?.impersonatedByUserId);
}
