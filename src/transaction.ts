/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DriverConnection, QueryResultLike } from "./drivers/types";
import { currentLogger } from "./logger";

type TransactionState = "open" | "committed" | "rolled back" | "released";

/**
 * A connection checked out of the pool with `BEGIN` already issued.
 *
 * @example
 * const tx = await DataSource.transaction();
 *
 * try {
 *   await files.using(tx).update({ id }, { path });
 *   await projects.using(tx).update({ id: projectId }, { size });
 *   await tx.commit();
 * } catch (error) {
 *   await tx.rollback();
 *   throw error;
 * }
 */
export class Transaction implements DriverConnection {
  private state: TransactionState = "open";
  private onCommit: (() => unknown)[] = [];

  constructor(private readonly client: DriverConnection) {}

  /** Whether statements can still be run. */
  get isOpen() {
    return this.state === "open";
  }

  /**
   * Runs a statement on this transaction's connection.
   *
   * @throws If the transaction has already been committed, rolled back or
   * released — a statement then would silently run outside it.
   */
  query<Row = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<Row>> {
    if (this.state !== "open") {
      throw new Error(`[Transaction] Cannot query: the transaction was ${this.state}.`);
    }

    return this.client.query(sql, params);
  }

  /**
   * Runs `fn` once this transaction has committed — and never, if it rolls
   * back.
   *
   * For work that must not happen unless the data is really there: clearing a
   * cache, pushing a realtime event, a best-effort email. Run inside the
   * transaction instead, it would announce a write that a later statement can
   * still roll back.
   *
   * Callbacks run in registration order, after the connection is back in the
   * pool, and `commit()` — so `await DataSource.transaction(…)` — resolves
   * only once they have finished: a cache cleared here is cleared before the
   * response that follows is sent.
   *
   * A callback that throws is logged and does **not** reach the caller. The
   * data is committed; an error there would read as a failed write, and a
   * caller that retries would write twice.
   *
   * The guarantee is one-directional. It promises "not sent unless written",
   * never "written, therefore sent": a process that dies between COMMIT and
   * the callback loses it. Anything that must happen belongs in an outbox — a
   * row written in this same transaction, which a worker sends and marks.
   *
   * @example
   * await DataSource.transaction(async (tx) => {
   *   const order = await orders.using(tx).insert({ … });
   *   tx.afterCommit(() => cache.delete(`orders:${order.userId}`));
   * });
   *
   * @throws If the transaction is no longer open — the moment to attach
   * something to its commit has passed.
   */
  afterCommit(fn: () => unknown): void {
    if (this.state !== "open") {
      throw new Error(`[Transaction] Cannot register afterCommit: the transaction was ${this.state}.`);
    }
    this.onCommit.push(fn);
  }

  /** Commits, then returns the connection to the pool, then runs {@link afterCommit} callbacks. */
  async commit() {
    if (this.state !== "open") {
      throw new Error(`[Transaction] Cannot commit: the transaction was ${this.state}.`);
    }

    const callbacks = this.onCommit;
    this.onCommit = [];

    try {
      await this.client.query("COMMIT");
      this.state = "committed";
    } catch (error) {
      /* A failed COMMIT leaves the transaction open on the connection, and
         handing that back to the pool would give the next borrower someone
         else's half-finished work. */
      await this.rollbackQuietly();
      throw error;
    } finally {
      this.client.release();
    }

    for (const fn of callbacks) {
      try {
        await fn();
      } catch (error) {
        currentLogger().error("[Transaction] An afterCommit callback failed. The transaction is committed.", error);
      }
    }
  }

  /**
   * Rolls back, then returns the connection to the pool.
   *
   * Doing this to a transaction that is already finished is a no-op rather
   * than an error, so it is safe in a `catch` that may or may not have run
   * after a commit.
   */
  async rollback() {
    if (this.state !== "open") return;
    this.onCommit = [];

    try {
      await this.client.query("ROLLBACK");
      this.state = "rolled back";
    } finally {
      this.client.release();
    }
  }

  /**
   * Returns the connection to the pool.
   *
   * An open transaction is rolled back first. node-postgres does not undo one
   * on release, so without this a forgotten commit would hand the next
   * borrower a connection with a transaction still open on it — and their
   * first statement would join it.
   */
  async release() {
    if (this.state === "open") {
      await this.rollback();
      return;
    }

    if (this.state !== "released") {
      this.state = "released";
    }
  }

  private async rollbackQuietly() {
    this.onCommit = [];
    try {
      await this.client.query("ROLLBACK");
      this.state = "rolled back";
    } catch {
      /* The connection is already unusable; releasing it is all that is left. */
      this.state = "released";
    }
  }
}
