import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db/postgres";
import { isSuperAdminEmail } from "@/lib/auth/superAdmin";
import { hashInviteToken } from "@/lib/auth/inviteToken";
import { parseOrgRole, type OrgRole } from "@/lib/auth/orgRole";
import { syncHubSpotRegistration } from "@/lib/hubspot/syncRegistration";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      token?: string;
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
    };

    const token = body.token?.trim();
    const email = body.email?.trim().toLowerCase();
    const password = body.password;
    const firstName = body.firstName?.trim();
    const lastName = body.lastName?.trim();

    if (!token || !email || !password || !firstName || !lastName) {
      return NextResponse.json(
        {
          error:
            "Invite token, email, password, first name, and last name are required.",
        },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email address." }, { status: 400 });
    }
    if (isSuperAdminEmail(email)) {
      return NextResponse.json(
        { error: "This email address cannot be registered." },
        { status: 403 }
      );
    }

    const tokenHash = hashInviteToken(token);
    const { rows: invRows } = await sql<{
      id: number;
      vendor_id: number;
      invite_email: string;
      org_role: string;
      expires_at: Date;
      consumed_at: Date | null;
      vendor_name: string;
    }>`
      SELECT vi.id, vi.vendor_id, vi.email AS invite_email, vi.org_role, vi.expires_at, vi.consumed_at,
        v.name AS vendor_name
      FROM vendor_invites vi
      INNER JOIN vendors v ON v.id = vi.vendor_id
      WHERE vi.token_hash = ${tokenHash}
      LIMIT 1
    `;

    const inv = invRows[0];
    if (!inv) {
      return NextResponse.json(
        { error: "Invalid or expired invite." },
        { status: 404 }
      );
    }
    if (inv.consumed_at != null) {
      return NextResponse.json(
        { error: "This invite was already used." },
        { status: 410 }
      );
    }
    if (new Date(inv.expires_at) <= new Date()) {
      return NextResponse.json(
        { error: "This invite has expired." },
        { status: 410 }
      );
    }
    if (inv.invite_email.toLowerCase() !== email) {
      return NextResponse.json(
        {
          error:
            "Email must match the address the invite was sent to. Use the same email shown on this page.",
        },
        { status: 400 }
      );
    }

    const roleParsed = parseOrgRole(inv.org_role);
    const orgRole: OrgRole = roleParsed ?? "clerk";

    const passwordHash = await bcrypt.hash(password, 12);

    try {
      await sql`
        INSERT INTO users (email, password_hash, first_name, last_name, vendor_id, org_role)
        VALUES (${email}, ${passwordHash}, ${firstName}, ${lastName}, ${inv.vendor_id}, ${orgRole})
      `;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return NextResponse.json(
          { error: "An account with this email already exists." },
          { status: 409 }
        );
      }
      throw e;
    }

    await sql`
      UPDATE vendor_invites
      SET consumed_at = NOW()
      WHERE id = ${inv.id} AND consumed_at IS NULL
    `;

    void syncHubSpotRegistration({
      email,
      firstName,
      lastName,
      organizationName: inv.vendor_name,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[register/join]", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("vendor_invites") || msg.includes("org_role")) {
      return NextResponse.json(
        {
          error:
            "Database needs migration for team sign-up. Run db/migrate_multi_user_org.sql in Neon.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Registration failed. Check database configuration." },
      { status: 500 }
    );
  }
}
