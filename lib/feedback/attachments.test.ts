import { describe, expect, it } from "vitest";
import {
  blobPublicHost,
  isAllowedAttachmentUrl,
  isAllowedUploadPathname,
  storeIdFromToken,
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
  it("allows png and jpeg files under feedback/", () => {
    expect(isAllowedUploadPathname("feedback/screenshot-1.png")).toBe(true);
    expect(isAllowedUploadPathname("feedback/screenshot-2.jpg")).toBe(true);
    expect(isAllowedUploadPathname("feedback/a.JPEG")).toBe(true);
  });

  it("rejects other folders, nested paths and other types", () => {
    expect(isAllowedUploadPathname("other/screenshot.png")).toBe(false);
    expect(isAllowedUploadPathname("feedback/../x.png")).toBe(false);
    expect(isAllowedUploadPathname("feedback/sub/x.png")).toBe(false);
    expect(isAllowedUploadPathname("feedback/x.svg")).toBe(false);
    expect(isAllowedUploadPathname("feedback/x.html")).toBe(false);
    expect(isAllowedUploadPathname("feedback/.png")).toBe(false);
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
});

describe("validateAttachments", () => {
  it("treats a missing field as no attachments", () => {
    expect(validateAttachments(undefined, HOST)).toEqual({ ok: true, urls: [] });
    expect(validateAttachments([], HOST)).toEqual({ ok: true, urls: [] });
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
