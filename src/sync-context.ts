/**
 * Where in a sync the current code is running, carried along the call chain.
 *
 * Two hangs at boot are only visible from here, and both would otherwise be
 * silent — no error, no log, a container that runs and never becomes ready:
 *
 * - a sync that reaches its own entity again, waiting on the lock the outer
 *   sync holds;
 * - an effect that writes through the pool rather than through the
 *   transaction it was given, onto a row that transaction has already
 *   written. The pool connection waits on the row lock; the transaction waits
 *   for the effect to return. Postgres sees one session idle in transaction
 *   and another waiting on it, and has no cycle to break.
 *
 * Per call chain rather than per process: three syncs of one entity running
 * side by side are legitimate — the lock serialises them — and a process-wide
 * set would mistake them for nesting.
 *
 * `node:async_hooks` is imported on first use, not here. This module is on the
 * root entry, and a static import would put a Node builtin in the graph of
 * everything that imports @ecosy/orm for a type.
 */
import type { AsyncLocalStorage } from "node:async_hooks";

export interface SyncContext {
  /** Entities whose sync is in progress on this chain. */
  syncing: ReadonlySet<string>;
  /** `entity:effect`, while an effect's own code runs. */
  effect: string | null;
}

let storage: AsyncLocalStorage<SyncContext> | null = null;

export async function syncContext(): Promise<AsyncLocalStorage<SyncContext>> {
  if (!storage) {
    const hooks = await import("node:async_hooks");
    storage ??= new hooks.AsyncLocalStorage<SyncContext>();
  }
  return storage;
}

/** Synchronous read. Null until the first sync has loaded the storage. */
export function currentSyncContext(): SyncContext | undefined {
  return storage?.getStore();
}

/**
 * Throws when called from inside an effect's own code. Called by everything
 * that reaches the pool — `DataSource.query` and `DataSource.transaction` —
 * so a statement that bypasses the effect's transaction is refused before it
 * is sent, rather than sent and left waiting.
 */
export function refuseInsideEffect(what: string): void {
  const effect = currentSyncContext()?.effect;
  if (!effect) return;
  throw new Error(
    `[DB] ${what} reached the pool from inside effect ${effect}. That runs outside the effect's ` +
      `transaction: it does not roll back with it, it cannot see what the effect has written, ` +
      `and if it touches a row the effect has written it waits for the effect's own lock ` +
      `forever. Use the \`tx\` or the \`repository\` the effect is given — or bind your own ` +
      `repository to it with .using(tx).`,
  );
}
