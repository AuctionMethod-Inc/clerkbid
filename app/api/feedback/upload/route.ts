import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { list } from "@vercel/blob";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { authOptions } from "@/lib/auth/options";
import {
  ATTACHMENT_LIMITS,
  isAllowedUploadPathname,
  userUploadPrefix,
} from "@/lib/feedback/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues short-lived client tokens so the feedback form can upload
 * screenshots straight to Vercel Blob (request bodies to functions are
 * capped well below 3 x 5 MB). Signed-in users only, each into their own
 * folder, with a daily cap counted from what is already in that folder.
 */
async function uploadsInLastDay(prefix: string): Promise<number> {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const { blobs } = await list({
    prefix,
    limit: ATTACHMENT_LIMITS.maxUploadsPerDay * 4,
  });
  return blobs.filter((b) => new Date(b.uploadedAt).getTime() > since).length;
}

export async function POST(req: Request) {
  if (!process.env.BLOB_READ_WRITE_TOKEN?.trim()) {
    return NextResponse.json(
      { error: "Screenshot uploads are not available right now." },
      { status: 503 }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!session?.user?.email || !userId) {
          throw new Error("Sign in to attach screenshots.");
        }
        if (!isAllowedUploadPathname(pathname, userId)) {
          throw new Error("Only PNG or JPEG screenshots can be attached.");
        }
        const used = await uploadsInLastDay(userUploadPrefix(userId));
        if (used >= ATTACHMENT_LIMITS.maxUploadsPerDay) {
          throw new Error(
            "You've attached a lot of screenshots today. Send this without them, or try again tomorrow."
          );
        }
        return {
          allowedContentTypes: [...ATTACHMENT_LIMITS.contentTypes],
          maximumSizeInBytes: ATTACHMENT_LIMITS.maxBytes,
          addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60 * 1000,
        };
      },
    });
    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Upload failed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
