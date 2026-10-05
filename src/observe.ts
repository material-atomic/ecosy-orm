/**
 * Every statement this package runs, told to whoever asks: the SQL exactly as it went to the database, its
 * parameters, how long it took, what it returned, how it failed, and where in the application it came from.
 *
 * For tracing slow queries and errors where the database alone cannot say enough: the database knows a statement's
 * normalised text and its average; this knows the call, its arguments and its caller.
 *
 * Observers cost nothing while none is installed — no stack is taken, no clock read. With one, a statement costs a
 * stack capture and two clock reads. An observer that throws is ignored: it never fails a query.
 *
 * @example
 * DataSource.observe((q) => {
 *   if (q.ms >= 500) report({ sql: q.sql, params: q.params, ms: q.ms, caller: q.caller, stack: q.stack });
 * });
 */

export interface QueryEvent {
  /** The statement, exactly as sent. */
  sql: string;
  /** Its parameters, as passed — scrub them before they leave the process. */
  params: readonly unknown[];
  /** From the call to the driver's answer, in milliseconds (fractional). */
  ms: number;
  /** Rows returned or affected; null when the statement failed. */
  rowCount: number | null;
  /** The database's error, when it failed: its message and SQLSTATE code. */
  error?: { message: string; code?: string };
  /** "pool": a statement on the pool. "client": on a held connection — a transaction, a lock, a migration. */
  connection: "pool" | "client";
  /** The first frame of the call outside this package and node's internals: where the application asked. */
  caller?: string;
  /** The application's frames above the call, nearest first (at most 10). */
  stack: string[];
  at: Date;
}

export type QueryObserver = (event: QueryEvent) => void;

/* On globalThis, like the pool: one list for every copy of this module a process loads (Next builds route handlers
   as separate module graphs; the CommonJS and ESM builds are separate modules). */
const KEY = Symbol.for("@ecosy/orm:observers");
const root = globalThis as typeof globalThis & { [KEY]?: Set<QueryObserver> };
const observers: Set<QueryObserver> = (root[KEY] ??= new Set());

/*
 * Where a statement was asked for. A repository method awaits before it reaches the driver, and V8 follows an async
 * chain only through `await`s: a caller that wrote `return repo.find(…)` is gone from the stack by the time the
 * statement runs. So the stack is taken where the application calls in — a repository method, synchronously — and
 * carried down to the driver in an AsyncLocalStorage.
 *
 * `node:async_hooks` is loaded only once something observes, so this module adds no Node builtin to the import graph
 * of an application that never does (the same reason `./migration` is not in the root export).
 */
interface CallSites {
  run<T>(site: string | undefined, fn: () => T): T;
  getStore(): string | undefined;
}
const SITES = Symbol.for("@ecosy/orm:call-sites");
const sitesRoot = globalThis as typeof globalThis & { [SITES]?: CallSites | null };

function loadCallSites(): void {
  if (sitesRoot[SITES] !== undefined) return;
  sitesRoot[SITES] = null;
  import("node:async_hooks")
    .then(({ AsyncLocalStorage }) => { sitesRoot[SITES] = new AsyncLocalStorage<string | undefined>(); })
    .catch(() => { /* no AsyncLocalStorage on this platform: the driver's own stack is used */ });
}

/** The stack here, deeper than the default ten frames (this package's own calls use those up). */
function stackHere(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const trace = new Error().stack;
  Error.stackTraceLimit = limit;
  return trace;
}

/**
 * Runs `fn` remembering where it was called from, for the statements it runs. Nothing at all while nobody observes.
 *
 * @internal Wraps the repository's public methods.
 */
export function atCallSite<T>(fn: () => T): T {
  const sites = sitesRoot[SITES];
  if (!observers.size || !sites || sites.getStore() !== undefined) return fn();
  return sites.run(stackHere(), fn);
}

/** Starts telling `observer` about every statement. Returns the way to stop. */
export function observeQueries(observer: QueryObserver): () => void {
  loadCallSites();
  observers.add(observer);
  return () => observers.delete(observer);
}

/* This package's own frames, and node's: what a caller is not. */
const OWN = /[\\/](?:@ecosy[\\/]orm|ecosy-orm|packages[\\/]orm)[\\/](?:dist|src)[\\/]|node:internal|node_modules[\\/]pg[\\/]|\(native\)|^\s*at (?:async )?Promise\b/;

function framesOf(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack.split("\n").slice(1).map((l) => l.trim()).filter((l) => l.startsWith("at ") && !OWN.test(l)).slice(0, 10);
}

/**
 * Runs `run` and tells the observers about it. Without observers, it is `run()` and nothing else.
 *
 * @internal Called by the drivers around every statement they send.
 */
export async function observed<Result extends { rowCount?: number | null }>(
  sql: string,
  params: readonly unknown[] | undefined,
  connection: QueryEvent["connection"],
  run: () => Promise<Result>,
): Promise<Result> {
  if (!observers.size) return run();

  /* Where the application called in, if a repository method remembered it; else the stack here, taken before the
     await (after it, the stack is the event loop's, not the caller's). */
  const trace = sitesRoot[SITES]?.getStore() ?? stackHere();
  const start = performance.now();
  let result: Result | undefined;
  let failure: { message: string; code?: string } | undefined;
  try {
    result = await run();
    return result;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    failure = { message: (error as Error)?.message ?? String(error), ...(code ? { code } : {}) };
    throw error;
  } finally {
    const ms = performance.now() - start;
    const stack = framesOf(trace);
    const caller = stack[0]?.replace(/^at\s+/, "");
    const event: QueryEvent = {
      sql, params: params ?? [], ms, rowCount: result ? (result.rowCount ?? null) : null, connection, stack, at: new Date(),
      ...(failure ? { error: failure } : {}),
      ...(caller ? { caller } : {}),
    };
    for (const observer of observers) {
      try {
        observer(event);
      } catch {
        /* an observer must never be the thing that fails a query */
      }
    }
  }
}
