import type { AuctionDB } from "./db";

const SETTINGS_ID = 1;

export async function ensureSettingsRow(db: AuctionDB): Promise<void> {
  const row = await db.settings.get(SETTINGS_ID);
  if (!row) {
    await db.settings.add({
      id: SETTINGS_ID,
      currentEventId: null,
      directoryDirty: false,
    });
  }
}

export async function getCurrentEventId(db: AuctionDB): Promise<number | null> {
  await ensureSettingsRow(db);
  const row = await db.settings.get(SETTINGS_ID);
  return row?.currentEventId ?? null;
}

export async function setCurrentEventId(
  db: AuctionDB,
  eventId: number | null
): Promise<void> {
  await ensureSettingsRow(db);
  await db.settings.update(SETTINGS_ID, { currentEventId: eventId });
}

/** Mark local Directory as needing a cloud push. */
export async function markDirectoryDirty(db: AuctionDB): Promise<void> {
  await ensureSettingsRow(db);
  await db.settings.update(SETTINGS_ID, { directoryDirty: true });
}

export async function clearDirectoryDirty(db: AuctionDB): Promise<void> {
  await ensureSettingsRow(db);
  await db.settings.update(SETTINGS_ID, { directoryDirty: false });
}
