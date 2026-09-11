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
 * The chain is a list of frames, each closed when its sync or effect returns.
 * AsyncLocalStorage hands the current frame to everything started under it —
 * timers, listeners, promises nobody awaits — and those can outlive the frame
 * by the life of the process. A flag set once and never cleared would forbid a
 * cache that happened to be first touched inside an effect from ever using the
 * pool again, with an error naming an effect long finished. Closed frames are
 * skipped, so such work sees the chain as it is now, not as it was.
 *
 * `node:async_hooks` is imported on first use, not here. This module is on the
 * root entry, and a static import would put a Node builtin in the graph of
 * everything that imports @ecosy/orm for a type.
 */
import type { AsyncLocalStorage } from "node:async_hooks";

export interface Frame {
  kind: "sync" | "effect";
  /** The entity for a sync; `entity:effect` for an effect. */
  name: string;
  parent: Frame | undefined;
  open: boolean;
}

let storage: AsyncLocalStorage<Frame> | null = null;

async function chain(): Promise<AsyncLocalStorage<Frame>> {
  if (!storage) {
    const hooks = await import("node:async_hooks");
    storage ??= new hooks.AsyncLocalStorage<Frame>();
  }
  return storage;
}

/** Runs `fn` inside a new frame under the current one, and closes it however `fn` ends. */
export async function withinFrame<T>(kind: Frame["kind"], name: string, fn: () => Promise<T>): Promise<T> {
  const store = await chain();
  const frame: Frame = { kind, name, parent: store.getStore(), open: true };
  try {
    return await store.run(frame, fn);
  } finally {
    frame.open = false;
  }
}

/** Whether a sync of `entity` is still running somewhere up this chain. */
export async function isSyncing(entity: string): Promise<boolean> {
  for (let f = (await chain()).getStore(); f; f = f.parent) {
    if (f.open && f.kind === "sync" && f.name === entity) return true;
  }
  return false;
}

/**
 * The effect whose own code is running, if any: the nearest open frame
 * decides. A sync started from inside an effect is sync code again — with its
 * own locks and statements on the pool — so an open sync frame shadows an
 * effect frame above it.
 */
export function currentEffect(): string | null {
  for (let f = storage?.getStore(); f; f = f.parent) {
    if (!f.open) continue;
    return f.kind === "effect" ? f.name : null;
  }
  return null;
}

/**
 * Throws when called from inside an effect's own code. Called by everything
 * that reaches the pool — `DataSource.query` and `DataSource.transaction` —
 * so a statement that bypasses the effect's transaction is refused before it
 * is sent, rather than sent and left waiting.
 */
export function refuseInsideEffect(what: string): void {
  const effect = currentEffect();
  if (!effect) return;
  throw new Error(
    `[DB] ${what} reached the pool from inside effect ${effect}. That runs outside the effect's ` +
      `transaction: it does not roll back with it, it cannot see what the effect has written, ` +
      `and if it touches a row the effect has written it waits for the effect's own lock ` +
      `forever. Use the \`tx\` or the \`repository\` the effect is given — or bind your own ` +
      `repository to it with .using(tx).`,
  );
}
