/**
 * Screenshot attachments for feedback. Images are uploaded from the browser
 * straight to Vercel Blob (see app/api/feedback/upload/route.ts), then the
 * feedback POST carries only their URLs. Pure helpers; unit tested.
 */

export const ATTACHMENT_LIMITS = {
  maxFiles: 3,
  maxBytes: 5 * 1024 * 1024,
  contentTypes: ["image/png", "image/jpeg"],
  pathPrefix: "feedback/",
  /** Upload permissions per user per rolling day, whether or not feedback was sent. */
  maxUploadsPerDay: 15,
} as const;

/** Each user uploads into their own folder so uploads can be counted per user. */
export function userUploadPrefix(userId: string): string {
  return `${ATTACHMENT_LIMITS.pathPrefix}u${userId}/`;
}

/** Read-write tokens look like vercel_blob_rw_<storeId>_<secret>. */
export function storeIdFromToken(token: string | undefined | null): string | null {
  const parts = (token ?? "").trim().split("_");
  const id = parts[3];
  return parts.length >= 5 && id ? id : null;
}

/** Host that serves public blobs from our store, or null when not configured. */
export function blobPublicHost(token: string | undefined | null): string | null {
  const id = storeIdFromToken(token);
  return id ? `${id.toLowerCase()}.public.blob.vercel-storage.com` : null;
}

/**
 * Whether the browser may upload to this pathname: in the user's own folder,
 * a plain file name with a png or jpeg extension.
 */
export function isAllowedUploadPathname(pathname: string, userId: string): boolean {
  if (!/^[0-9]+$/.test(userId)) return false;
  const prefix = userUploadPrefix(userId);
  if (!pathname.startsWith(prefix)) return false;
  const name = pathname.slice(prefix.length);
  return /^[A-Za-z0-9._-]{1,120}\.(png|jpe?g)$/i.test(name) && !name.startsWith(".");
}

/** A URL we accept as a feedback attachment: https, our store, under pathPrefix. */
export function isAllowedAttachmentUrl(
  raw: string,
  host: string | null,
  pathPrefix: string = ATTACHMENT_LIMITS.pathPrefix
): boolean {
  if (!host || raw.length > 512) return false;
  // The URL is written verbatim into GitHub markdown and Slack mrkdwn, so it
  // must hold no characters that end a link or start new markup.
  if (/[\s()[\]<>|]/.test(raw)) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.href === raw &&
    u.protocol === "https:" &&
    u.hostname === host &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    u.pathname.startsWith(`/${pathPrefix}`)
  );
}

export type AttachmentsResult =
  | { ok: true; urls: string[] }
  | { ok: false; error: string };

export function validateAttachments(
  raw: unknown,
  host: string | null,
  pathPrefix: string = ATTACHMENT_LIMITS.pathPrefix
): AttachmentsResult {
  if (raw == null) return { ok: true, urls: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "Invalid screenshots." };
  if (raw.length > ATTACHMENT_LIMITS.maxFiles) {
    return {
      ok: false,
      error: `You can attach up to ${ATTACHMENT_LIMITS.maxFiles} screenshots.`,
    };
  }
  const urls: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || !isAllowedAttachmentUrl(v, host, pathPrefix)) {
      return { ok: false, error: "Invalid screenshot link. Try attaching it again." };
    }
    if (!urls.includes(v)) urls.push(v);
  }
  return { ok: true, urls };
}
