import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db/postgres";
import { isSuperAdminEmail } from "@/lib/auth/superAdmin";
import { slugifyOrgName } from "@/lib/auth/slug";
import { syncHubSpotRegistration } from "@/lib/hubspot/syncRegistration";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      email?: string;
      password?: string;
      firstName?: string;
      lastName?: string;
      organizationName?: string;
    };

    const email = body.email?.trim().toLowerCase();
    const password = body.password;
    const firstName = body.firstName?.trim();
    const lastName = body.lastName?.trim();
    const organizationName = body.organizationName?.trim();

    if (!email || !password || !organizationName || !firstName || !lastName) {
      return NextResponse.json(
        {
          error:
            "Email, password, organization name, first name, and last name are required.",
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

    const passwordHash = await bcrypt.hash(password, 12);

    let baseSlug = slugifyOrgName(organizationName);
    let slug = baseSlug;
    let vendorId: number | null = null;

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const { rows } = await sql<{ id: number }>`
          INSERT INTO vendors (name, slug)
          VALUES (${organizationName}, ${slug})
          RETURNING id
        `;
        vendorId = rows[0]?.id ?? null;
        break;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("unique") || msg.includes("duplicate")) {
          slug = `${baseSlug}-${attempt + 1}`;
          continue;
        }
        throw e;
      }
    }

    if (vendorId == null) {
      return NextResponse.json(
        { error: "Could not create organization. Try a different name." },
        { status: 409 }
      );
    }

    try {
      await sql`
        INSERT INTO users (email, password_hash, first_name, last_name, vendor_id, org_role)
        VALUES (${email}, ${passwordHash}, ${firstName}, ${lastName}, ${vendorId}, 'admin')
      `;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await sql`DELETE FROM vendors WHERE id = ${vendorId}`;
      if (msg.includes("unique") || msg.includes("duplicate")) {
        return NextResponse.json(
          { error: "An account with this email already exists." },
          { status: 409 }
        );
      }
      throw e;
    }

    void syncHubSpotRegistration({
      email,
      firstName,
      lastName,
      organizationName,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(e);
    const code =
      typeof e === "object" && e !== null && "code" in e
        ? String((e as { code?: string }).code)
        : "";
    const msg = e instanceof Error ? e.message : String(e);
    if (
      code === "42P01" ||
      /relation "vendors" does not exist/i.test(msg)
    ) {
      return NextResponse.json(
        {
          error:
            "Database is not initialized. In Neon: open SQL Editor, run the SQL in db/schema.sql from this project (creates vendors and users tables), then try again.",
        },
        { status: 503 }
      );
    }
    if (
      code === "42703" ||
      /column "org_role"/i.test(msg) ||
      /column "first_name"/i.test(msg) ||
      /column "last_name"/i.test(msg)
    ) {
      return NextResponse.json(
        {
          error:
            "Database needs a one-time update. In Neon SQL Editor, run db/migrate_users_first_last.sql and db/migrate_multi_user_org.sql from the ClerkBid repo, then try again.",
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
