import { NextResponse } from "next/server";
import { requireSuperAdminNotImpersonating } from "@/lib/admin/requireSuperAdmin";
import {
  PlanChangedError,
  deleteUsers,
  previewUserDeletion,
} from "@/lib/admin/deleteUsers";
import {
  BLOCK_MESSAGES,
  parseUserIds,
  type DeletePlan,
} from "@/lib/admin/deleteUsersPlan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function describePlan(plan: DeletePlan) {
  return {
    users: plan.deletable.map((u) => ({
      id: u.id,
      email: u.email,
      name: `${u.first_name} ${u.last_name}`.trim(),
      orgRole: u.org_role,
      vendorId: u.vendor_id,
    })),
    orgsToDelete: plan.orgsToDelete.map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      syncedEvents: o.syncedEvents,
      syncOps: o.syncOps,
    })),
    orgsLosingAdmin: plan.orgsLosingAdmin.map((o) => ({
      id: o.id,
      name: o.name,
    })),
  };
}

function blockedResponse(plan: DeletePlan) {
  return NextResponse.json(
    {
      error: plan.blocked
        .map((b) => `User ${b.id}: ${BLOCK_MESSAGES[b.reason]}`)
        .join(" "),
      blocked: plan.blocked,
    },
    { status: 400 }
  );
}

/**
 * Two-step deletion. `{ userIds, dryRun: true }` returns what would be deleted
 * and changes nothing. The real call must send back `expectedOrgIds` (the
 * organizations the preview said would be removed); if they no longer match,
 * nothing is deleted and the caller must review again.
 */
export async function POST(req: Request) {
  const session = await requireSuperAdminNotImpersonating();
  if (session instanceof NextResponse) return session;

  const adminId = parseInt(session.user.id, 10);
  if (!Number.isFinite(adminId)) {
    return NextResponse.json({ error: "Invalid session." }, { status: 401 });
  }

  let body: { userIds?: unknown; dryRun?: unknown; expectedOrgIds?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = parseUserIds(body.userIds);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  try {
    if (body.dryRun === true) {
      const plan = await previewUserDeletion(parsed.ids, adminId);
      if (plan.blocked.length > 0) return blockedResponse(plan);
      return NextResponse.json({ ok: true, ...describePlan(plan) });
    }

    const expected = body.expectedOrgIds;
    if (
      !Array.isArray(expected) ||
      !expected.every((x) => typeof x === "number" && Number.isInteger(x))
    ) {
      return NextResponse.json(
        { error: "expectedOrgIds (from the preview) is required." },
        { status: 400 }
      );
    }

    const result = await deleteUsers(parsed.ids, adminId, expected as number[]);
    if (!result.ok) return blockedResponse(result.plan);

    // Audit trail (the admin page promises deletions are logged).
    console.warn(
      "[admin/delete-users] deleted",
      JSON.stringify({
        byUserId: adminId,
        users: result.plan.deletable.map((u) => ({ id: u.id, email: u.email })),
        orgs: result.plan.orgsToDelete.map((o) => ({ id: o.id, slug: o.slug })),
      })
    );
    return NextResponse.json({
      ok: true,
      deletedUserIds: result.plan.deletable.map((u) => u.id),
      deletedOrgIds: result.plan.orgsToDelete.map((o) => o.id),
    });
  } catch (e: unknown) {
    if (e instanceof PlanChangedError) {
      return NextResponse.json(
        {
          error:
            "Organization membership changed since the preview. Nothing was deleted; review and try again.",
        },
        { status: 409 }
      );
    }
    console.error("[admin/delete-users]", e);
    return NextResponse.json(
      { error: "Could not delete users. Nothing was deleted." },
      { status: 500 }
    );
  }
}
