/* eslint-disable @typescript-eslint/no-explicit-any */

import type { DriverConnection, QueryResultLike } from "./drivers/types";

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

  /** Commits, then returns the connection to the pool. */
  async commit() {
    if (this.state !== "open") {
      throw new Error(`[Transaction] Cannot commit: the transaction was ${this.state}.`);
    }

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
    try {
      await this.client.query("ROLLBACK");
      this.state = "rolled back";
    } catch {
      /* The connection is already unusable; releasing it is all that is left. */
      this.state = "released";
    }
  }
}
