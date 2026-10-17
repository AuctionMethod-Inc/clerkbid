import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { authOptions } from "@/lib/auth/options";
import {
  ATTACHMENT_LIMITS,
  isAllowedUploadPathname,
} from "@/lib/feedback/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Issues short-lived client tokens so the feedback form can upload
 * screenshots straight to Vercel Blob (request bodies to functions are
 * capped well below 3 x 5 MB). Signed-in users only.
 */
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
        if (!session?.user?.email) {
          throw new Error("Sign in to attach screenshots.");
        }
        if (!isAllowedUploadPathname(pathname)) {
          throw new Error("Only PNG or JPEG screenshots can be attached.");
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
