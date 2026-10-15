import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { sql } from "@/lib/db/postgres";
import {
  DIRECTORY_EXPORT_VERSION,
  isDirectoryExportPayload,
} from "@/lib/directory/payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MISSING_TABLE =
  "Database is missing the vendor directory table. Run db/migrate_vendor_directory.sql in Neon.";

/** Allow tiny clock skew when comparing baseUpdatedAt to server updated_at. */
const SKEW_MS = 2000;

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const vendorId = parseInt(session.user.vendorId, 10);
    if (!Number.isFinite(vendorId)) {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
    }

    const { rows } = await sql<{ payload: unknown; updated_at: Date }>`
      SELECT payload, updated_at
      FROM vendor_directory_snapshots
      WHERE vendor_id = ${vendorId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    return NextResponse.json({
      payload: row.payload,
      updatedAt: new Date(row.updated_at).toISOString(),
    });
  } catch (e) {
    console.error("[sync/directory GET]", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("vendor_directory_snapshots") || msg.includes("does not exist")) {
      return NextResponse.json({ error: MISSING_TABLE }, { status: 503 });
    }
    return NextResponse.json(
      { error: "Could not load directory." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    const userId = parseInt(session.user.id, 10);
    const vendorId = parseInt(session.user.vendorId, 10);
    if (!Number.isFinite(userId) || !Number.isFinite(vendorId)) {
      return NextResponse.json({ error: "Invalid session." }, { status: 401 });
    }

    const body = (await req.json()) as {
      payload?: unknown;
      clientExportedAt?: string;
      baseUpdatedAt?: string | null;
    };
    if (body.payload == null || typeof body.payload !== "object") {
      return NextResponse.json({ error: "payload is required." }, { status: 400 });
    }
    const payloadJson = JSON.stringify(body.payload);

    const { rows: existing } = await sql<{
      updated_at: Date;
      payload: unknown;
      same: boolean;
    }>`
      SELECT updated_at, payload, (payload = ${payloadJson}::jsonb) AS same
      FROM vendor_directory_snapshots
      WHERE vendor_id = ${vendorId}
      LIMIT 1
    `;
    const prev = existing[0];

    if (prev) {
      const serverMs = new Date(prev.updated_at).getTime();
      const baseRaw = body.baseUpdatedAt;
      const baseMs =
        baseRaw != null && baseRaw !== ""
          ? new Date(baseRaw).getTime()
          : NaN;
      const baseMissing = baseRaw == null || baseRaw === "";
      const baseStale =
        !Number.isFinite(baseMs) || serverMs > baseMs + SKEW_MS;

      if (baseMissing || baseStale) {
        // Same payload is idempotent — treat as success without bumping.
        if (prev.same) {
          return NextResponse.json({
            ok: true,
            unchanged: true,
            updatedAt: new Date(prev.updated_at).toISOString(),
          });
        }
        return NextResponse.json(
          {
            error: "stale_base",
            updatedAt: new Date(prev.updated_at).toISOString(),
            payload: isDirectoryExportPayload(prev.payload)
              ? prev.payload
              : prev.payload,
          },
          { status: 409 }
        );
      }
    }

    if (prev?.same) {
      return NextResponse.json({
        ok: true,
        unchanged: true,
        updatedAt: new Date(prev.updated_at).toISOString(),
      });
    }

    const { rows } = await sql<{ updated_at: Date }>`
      INSERT INTO vendor_directory_snapshots
        (vendor_id, last_push_user_id, payload, payload_version, updated_at)
      VALUES
        (${vendorId}, ${userId}, ${payloadJson}::jsonb, ${DIRECTORY_EXPORT_VERSION}, NOW())
      ON CONFLICT (vendor_id) DO UPDATE SET
        payload = EXCLUDED.payload,
        payload_version = EXCLUDED.payload_version,
        last_push_user_id = EXCLUDED.last_push_user_id,
        updated_at = NOW()
      RETURNING updated_at
    `;
    const updated = rows[0];
    return NextResponse.json({
      ok: true,
      updatedAt: updated
        ? new Date(updated.updated_at).toISOString()
        : new Date().toISOString(),
    });
  } catch (e) {
    console.error("[sync/directory POST]", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("vendor_directory_snapshots") || msg.includes("does not exist")) {
      return NextResponse.json({ error: MISSING_TABLE }, { status: 503 });
    }
    return NextResponse.json(
      { error: "Could not save directory." },
      { status: 500 }
    );
  }
}
