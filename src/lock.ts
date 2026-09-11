import { DataSource } from "./data-source";
import { currentLogger } from "./logger";

/**
 * Runs `fn` while holding a named lock, so two processes booting at once do not
 * both decide the same work has not been done yet — a migration file, or an
 * entity effect that is meant to run once.
 *
 * The lock is taken on a connection this function keeps checked out, because an
 * advisory lock belongs to a session: taking it through a pooled query would
 * return the connection — and release the lock — before the work even starts.
 * That is the same mistake the migration loop once made, in a different
 * costume.
 *
 * An engine whose dialect declares no advisory lock runs unguarded, and says so
 * rather than implying a protection it does not have.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const dialect = DataSource.dialect;

  if (!dialect.advisoryLock || !dialect.advisoryUnlock) {
    currentLogger().warn(
      `[DB] Driver "${DataSource.current.name}" exposes no advisory lock, so "${key}" runs ` +
        `unguarded. Two processes booting together may both do the work it guards.`,
    );
    return fn();
  }

  const holder = await DataSource.transaction();

  try {
    await holder.query(dialect.advisoryLock(key));
    return await fn();
  } finally {
    /* Commit releases the connection, and the session lock with it; the unlock
       is explicit anyway so the intent survives a future change to how the
       transaction is closed. */
    try {
      await holder.query(dialect.advisoryUnlock(key));
    } catch {
      /* Losing the unlock is not worth masking whatever `fn` threw. */
    }
    await holder.commit();
  }
}
