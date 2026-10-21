import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { sql } from "@/lib/db/postgres";
import { publishEventSyncNudge } from "@/lib/ably/publishEventSync";
import { EXPORT_VERSION } from "@/lib/services/dataPorter";
import { eventSnapshotsContentEqual } from "@/lib/services/snapshotContentEqual";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      eventSyncId?: string;
      payload?: unknown;
      clientExportedAt?: string;
      force?: boolean;
      baseUpdatedAt?: string | null;
    };

    const eventSyncId = body.eventSyncId?.trim();
    if (!eventSyncId || !UUID_RE.test(eventSyncId)) {
      return NextResponse.json(
        { error: "Valid eventSyncId (UUID) is required." },
        { status: 400 }
      );
    }
    if (body.payload == null || typeof body.payload !== "object") {
      return NextResponse.json({ error: "payload is required." }, { status: 400 });
    }
    const clientExportedAt = body.clientExportedAt?.trim();
    if (!clientExportedAt) {
      return NextResponse.json(
        { error: "clientExportedAt (ISO) is required." },
        { status: 400 }
      );
    }

    const clientTime = new Date(clientExportedAt);
    if (Number.isNaN(clientTime.getTime())) {
      return NextResponse.json(
        { error: "clientExportedAt must be a valid ISO date." },
        { status: 400 }
      );
    }

    const payloadJson = JSON.stringify(body.payload);

    const { rows: existing } = await sql<{
      updated_at: Date;
      updated_at_exact: string;
      payload: unknown;
    }>`
      SELECT updated_at, updated_at::text AS updated_at_exact, payload
      FROM event_cloud_snapshots
      WHERE vendor_id = ${vendorId} AND event_sync_id = ${eventSyncId}::uuid
      LIMIT 1
    `;
    const existingRow = existing[0];
    if (
      existingRow &&
      eventSnapshotsContentEqual(existingRow.payload, body.payload)
    ) {
      return NextResponse.json({
        ok: true,
        unchanged: true,
        updatedAt: new Date(existingRow.updated_at).toISOString(),
      });
    }

    const conflict = (serverUpdatedAt: Date) =>
      NextResponse.json(
        {
          error: "Conflict",
          code: "sync_conflict",
          serverUpdatedAt: new Date(serverUpdatedAt).toISOString(),
        },
        { status: 409 }
      );

    if (!body.force && existingRow) {
      if ("baseUpdatedAt" in body) {
        // The device says which cloud version it last downloaded or saved.
        // If the cloud has moved on, this save never saw those changes.
        const baseMs =
          body.baseUpdatedAt != null && body.baseUpdatedAt !== ""
            ? new Date(body.baseUpdatedAt).getTime()
            : NaN;
        if (
          !Number.isFinite(baseMs) ||
          new Date(existingRow.updated_at).getTime() > baseMs
        ) {
          return conflict(existingRow.updated_at);
        }
      } else if (new Date(existingRow.updated_at) > clientTime) {
        // Older app versions send no base; keep the clock comparison for them.
        return conflict(existingRow.updated_at);
      }
    }

    // The checks above and this write are separate statements, so two saves
    // can both pass them. A checked save only overwrites the exact row version
    // it was checked against (text keeps microseconds); with no row seen, a
    // row inserted meanwhile wins. No row back means another save got there
    // first. A forced save overwrites as before.
    const expectedVersion = body.force
      ? undefined
      : existingRow?.updated_at_exact ?? null;
    const { rows } = await sql<{ updated_at: Date }>`
      INSERT INTO event_cloud_snapshots
        (vendor_id, event_sync_id, last_push_user_id, payload, payload_version, updated_at)
      VALUES
        (${vendorId}, ${eventSyncId}::uuid, ${userId}, ${payloadJson}::jsonb, ${EXPORT_VERSION}, NOW())
      ON CONFLICT (vendor_id, event_sync_id) DO UPDATE SET
        payload = EXCLUDED.payload,
        payload_version = EXCLUDED.payload_version,
        last_push_user_id = EXCLUDED.last_push_user_id,
        updated_at = NOW()
      WHERE ${expectedVersion === undefined}::boolean OR event_cloud_snapshots.updated_at = ${expectedVersion ?? null}::timestamptz
      RETURNING updated_at
    `;

    const updated = rows[0];
    if (!updated) {
      const { rows: current } = await sql<{ updated_at: Date }>`
        SELECT updated_at
        FROM event_cloud_snapshots
        WHERE vendor_id = ${vendorId} AND event_sync_id = ${eventSyncId}::uuid
        LIMIT 1
      `;
      return conflict(current[0]?.updated_at ?? new Date());
    }
    publishEventSyncNudge(vendorId, eventSyncId);
    return NextResponse.json({
      ok: true,
      updatedAt: new Date(updated.updated_at).toISOString(),
    });
  } catch (e) {
    console.error("[sync/push]", e);
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("event_cloud_snapshots") || msg.includes("does not exist")) {
      return NextResponse.json(
        {
          error:
            "Database is missing cloud sync tables. Run db/migrate_cloud_sync.sql in Neon.",
        },
        { status: 503 }
      );
    }
    if (msg.includes("vendor_id") || msg.includes("unique")) {
      return NextResponse.json(
        {
          error:
            "Database needs migration for shared organization backups. Run db/migrate_multi_user_org.sql in Neon.",
        },
        { status: 503 }
      );
    }
    return NextResponse.json(
      { error: "Could not save cloud backup." },
      { status: 500 }
    );
  }
}
