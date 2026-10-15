"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import {
  getAuctionDB,
  migrateLegacyToUserDb,
  type AuctionDB,
} from "@/lib/db";
import { ensureSettingsRow } from "@/lib/settings";
import { readOfflineUserId } from "@/lib/auth/offlineSession";

export type UserDbContextValue = {
  db: AuctionDB | null;
  /** Legacy migration + settings row ready for this user. */
  ready: boolean;
};

const UserDbContext = createContext<UserDbContextValue | null>(null);

export function UserDbProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const [offlineUid, setOfflineUid] = useState<string | null>(() =>
    readOfflineUserId()
  );

  useEffect(() => {
    const sync = () => setOfflineUid(readOfflineUserId());
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (session?.user?.id) setOfflineUid(readOfflineUserId());
  }, [session?.user?.id]);

  const rawUserId = session?.user?.id ?? offlineUid ?? null;
  const userId =
    rawUserId != null && String(rawUserId).length > 0
      ? String(rawUserId)
      : null;

  const db = useMemo(() => {
    if (!userId) return null;
    return getAuctionDB(userId);
  }, [userId]);

  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!db) {
      setReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await migrateLegacyToUserDb(db);
        await ensureSettingsRow(db);
        const { seedDirectoryFromEvents } = await import(
          "@/lib/directory/seed"
        );
        await seedDirectoryFromEvents(db);
        const { cleanupDirectoryDuplicates } = await import(
          "@/lib/directory/sync"
        );
        await cleanupDirectoryDuplicates(db);
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db]);

  const value = useMemo<UserDbContextValue>(
    () => ({ db, ready: ready && db != null }),
    [db, ready]
  );

  return (
    <UserDbContext.Provider value={value}>{children}</UserDbContext.Provider>
  );
}

export function useUserDb(): UserDbContextValue {
  const ctx = useContext(UserDbContext);
  if (!ctx) {
    throw new Error("useUserDb must be used within UserDbProvider");
  }
  return ctx;
}
