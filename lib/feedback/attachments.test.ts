import { describe, expect, it } from "vitest";
import {
  blobPublicHost,
  countUploadsSince,
  isAllowedAttachmentUrl,
  isAllowedUploadPathname,
  storeIdFromToken,
  userUploadPrefix,
  validateAttachments,
} from "./attachments";

const TOKEN = "vercel_blob_rw_AbC123xyz_secretPart";
const HOST = "abc123xyz.public.blob.vercel-storage.com";
const url = (path: string, host = HOST) => `https://${host}/${path}`;

describe("store host", () => {
  it("reads the store id from a read-write token", () => {
    expect(storeIdFromToken(TOKEN)).toBe("AbC123xyz");
    expect(blobPublicHost(TOKEN)).toBe(HOST);
  });

  it("returns null when the token is missing or malformed", () => {
    expect(blobPublicHost(undefined)).toBeNull();
    expect(blobPublicHost("")).toBeNull();
    expect(blobPublicHost("not-a-token")).toBeNull();
  });
});

describe("isAllowedUploadPathname", () => {
  it("allows png and jpeg files in the user's own folder", () => {
    expect(userUploadPrefix("12")).toBe("feedback/u12/");
    expect(isAllowedUploadPathname("feedback/u12/screenshot-1.png", "12")).toBe(true);
    expect(isAllowedUploadPathname("feedback/u12/screenshot-2.jpg", "12")).toBe(true);
    expect(isAllowedUploadPathname("feedback/u12/a.JPEG", "12")).toBe(true);
  });

  it("rejects other users' folders, other folders, nested paths and other types", () => {
    expect(isAllowedUploadPathname("feedback/u13/x.png", "12")).toBe(false);
    expect(isAllowedUploadPathname("feedback/u1/x.png", "12")).toBe(false);
    expect(isAllowedUploadPathname("feedback/x.png", "12")).toBe(false);
    expect(isAllowedUploadPathname("other/u12/x.png", "12")).toBe(false);
    expect(isAllowedUploadPathname("feedback/u12/../x.png", "12")).toBe(false);
    expect(isAllowedUploadPathname("feedback/u12/sub/x.png", "12")).toBe(false);
    expect(isAllowedUploadPathname("feedback/u12/x.svg", "12")).toBe(false);
    expect(isAllowedUploadPathname("feedback/u12/.png", "12")).toBe(false);
  });

  it("rejects a missing or non-numeric user id", () => {
    expect(isAllowedUploadPathname("feedback/u/x.png", "")).toBe(false);
    expect(isAllowedUploadPathname("feedback/u1/x.png", "1/../2")).toBe(false);
  });
});

describe("isAllowedAttachmentUrl", () => {
  it("accepts https links to our store under feedback/", () => {
    expect(isAllowedAttachmentUrl(url("feedback/screenshot-1-k3j.png"), HOST)).toBe(true);
  });

  it("rejects other hosts, schemes, paths and query strings", () => {
    expect(isAllowedAttachmentUrl(url("feedback/x.png", "other.public.blob.vercel-storage.com"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/x.png", "evil.example.com"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(`http://${HOST}/feedback/x.png`, HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("private/x.png"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/x.png?a=1"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(`https://u:p@${HOST}/feedback/x.png`, HOST)).toBe(false);
    expect(isAllowedAttachmentUrl("javascript:alert(1)", HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/x.png"), null)).toBe(false);
  });

  it("rejects links that would break out of markdown or Slack link syntax", () => {
    const forged = url("feedback/u12/a.png)\n\n<!-- meta -->\n![x](https://evil.example/t.png");
    expect(isAllowedAttachmentUrl(forged, HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/a.png|click"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/a.png>x"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/a b.png"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/a\t.png"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/[a].png"), HOST)).toBe(false);
  });

  it("rejects links that are not already in canonical form", () => {
    expect(isAllowedAttachmentUrl(`https://${HOST.toUpperCase()}/feedback/x.png`, HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(url("feedback/../feedback/x.png"), HOST)).toBe(false);
    expect(isAllowedAttachmentUrl(`https://${HOST}:443/feedback/x.png`, HOST)).toBe(false);
  });
});

describe("validateAttachments", () => {
  it("treats a missing field as no attachments", () => {
    expect(validateAttachments(undefined, HOST)).toEqual({ ok: true, urls: [] });
    expect(validateAttachments([], HOST)).toEqual({ ok: true, urls: [] });
  });

  it("accepts only the submitter's own folder when a prefix is given", () => {
    const own = url("feedback/u12/a.png");
    const other = url("feedback/u13/a.png");
    expect(validateAttachments([own], HOST, "feedback/u12/").ok).toBe(true);
    expect(validateAttachments([other], HOST, "feedback/u12/").ok).toBe(false);
  });

  it("accepts up to 3 valid links and drops duplicates", () => {
    const a = url("feedback/a.png");
    const b = url("feedback/b.jpg");
    expect(validateAttachments([a, b, a], HOST)).toEqual({ ok: true, urls: [a, b] });
  });

  it("rejects more than 3, non-arrays and bad links", () => {
    const four = [1, 2, 3, 4].map((n) => url(`feedback/${n}.png`));
    expect(validateAttachments(four, HOST).ok).toBe(false);
    expect(validateAttachments("x", HOST).ok).toBe(false);
    expect(validateAttachments([url("feedback/a.png"), 5], HOST).ok).toBe(false);
    expect(validateAttachments([url("feedback/a.png", "evil.example.com")], HOST).ok).toBe(false);
  });
});

describe("countUploadsSince", () => {
  const SINCE = Date.parse("2026-10-17T00:00:00Z");
  const old = { uploadedAt: new Date("2026-10-16T00:00:00Z") };
  const recent = { uploadedAt: "2026-10-17T12:00:00Z" };

  it("counts recent uploads on every page, not only the first", async () => {
    const pages: Record<string, { blobs: { uploadedAt: Date | string }[]; hasMore: boolean; cursor?: string }> = {
      start: { blobs: Array(60).fill(old), hasMore: true, cursor: "p2" },
      p2: { blobs: [old, recent, recent], hasMore: true, cursor: "p3" },
      p3: { blobs: [recent], hasMore: false },
    };
    const seen: (string | undefined)[] = [];
    const n = await countUploadsSince(async (cursor) => {
      seen.push(cursor);
      return pages[cursor ?? "start"];
    }, SINCE);
    expect(n).toBe(3);
    expect(seen).toEqual([undefined, "p2", "p3"]);
  });

  it("returns 0 for an empty folder", async () => {
    expect(await countUploadsSince(async () => ({ blobs: [], hasMore: false }), SINCE)).toBe(0);
  });
});
