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
} as const;

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
 * Whether the browser may upload to this pathname: under feedback/, a plain
 * file name with a png or jpeg extension.
 */
export function isAllowedUploadPathname(pathname: string): boolean {
  if (!pathname.startsWith(ATTACHMENT_LIMITS.pathPrefix)) return false;
  const name = pathname.slice(ATTACHMENT_LIMITS.pathPrefix.length);
  return /^[A-Za-z0-9._-]{1,120}\.(png|jpe?g)$/i.test(name) && !name.startsWith(".");
}

/** A URL we accept as a feedback attachment: https, our store, feedback/ path. */
export function isAllowedAttachmentUrl(raw: string, host: string | null): boolean {
  if (!host || raw.length > 512) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.hostname === host &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    u.pathname.startsWith(`/${ATTACHMENT_LIMITS.pathPrefix}`)
  );
}

export type AttachmentsResult =
  | { ok: true; urls: string[] }
  | { ok: false; error: string };

export function validateAttachments(raw: unknown, host: string | null): AttachmentsResult {
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
    if (typeof v !== "string" || !isAllowedAttachmentUrl(v, host)) {
      return { ok: false, error: "Invalid screenshot link. Try attaching it again." };
    }
    if (!urls.includes(v)) urls.push(v);
  }
  return { ok: true, urls };
}
