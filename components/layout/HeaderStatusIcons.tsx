"use client";

import { SyncStatusIndicator } from "./SyncStatusBar";
import { DisplayQuickAccess } from "./DisplayQuickAccess";

/** Sync status and display quick access, shown next to the ClerkBid logo. */
export function HeaderStatusIcons({
  tooltipAlign = "right",
}: {
  tooltipAlign?: "left" | "right";
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <SyncStatusIndicator tooltipAlign={tooltipAlign} />
      <DisplayQuickAccess />
    </div>
  );
}
