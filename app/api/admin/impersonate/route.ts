import { NextResponse } from "next/server";
import { sql } from "@/lib/db/postgres";
import {
  generateImpersonationSecret,
  hashImpersonationToken,
} from "@/lib/admin/impersonationToken";
import { requireSuperAdminNotImpersonating } from "@/lib/admin/requireSuperAdmin";
import { isSuperAdminUserRow } from "@/lib/auth/superAdmin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TTL_MS = 5 * 60 * 1000;

export async function POST(req: Request) {
  const session = await requireSuperAdminNotImpersonating();
  if (session instanceof NextResponse) return session;

  let body: { targetUserId?: number };
  try {
    body = (await req.json()) as { targetUserId?: number };
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const targetUserId = body.targetUserId;
  if (
    targetUserId == null ||
    typeof targetUserId !== "number" ||
    !Number.isFinite(targetUserId) ||
    targetUserId < 1
  ) {
    return NextResponse.json(
      { error: "targetUserId (positive number) is required." },
      { status: 400 }
    );
  }

  const adminId = parseInt(session.user.id, 10);
  if (targetUserId === adminId) {
    return NextResponse.json(
      { error: "Cannot impersonate your own account." },
      { status: 400 }
    );
  }

  try {
    const { rows } = await sql<{ id: number; email: string }>`
      SELECT id, email FROM users WHERE id = ${targetUserId} LIMIT 1
    `;
    if (!rows[0]) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    // A super admin session minted via impersonation carries no impersonatedBy
    // marker, so one super admin could silently become another. Block it.
    if (isSuperAdminUserRow(rows[0])) {
      return NextResponse.json(
        { error: "Cannot impersonate another super admin." },
        { status: 403 }
      );
    }

    const plaintext = generateImpersonationSecret();
    const tokenHash = hashImpersonationToken(plaintext);
    const expiresAt = new Date(Date.now() + TTL_MS);

    await sql`
      INSERT INTO admin_impersonation_tokens
        (token_hash, created_by_user_id, subject_user_id, expires_at)
      VALUES
        (${tokenHash}, ${adminId}, ${targetUserId}, ${expiresAt.toISOString()}::timestamptz)
    `;

    return NextResponse.json({
      impersonationToken: plaintext,
      expiresInSeconds: Math.floor(TTL_MS / 1000),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("admin_impersonation_tokens") &&
      msg.includes("does not exist")
    ) {
      return NextResponse.json(
        {
          error:
            "Admin impersonation is not set up. Run db/migrate_admin_impersonation.sql in Neon.",
        },
        { status: 503 }
      );
    }
    console.error("[admin/impersonate]", e);
    return NextResponse.json(
      { error: "Could not create impersonation token." },
      { status: 500 }
    );
  }
}
