/* eslint-disable @typescript-eslint/no-explicit-any */
import "server-only";

import type { EntityConstructor } from "./entity";
import { Transaction } from "./transaction";
import type { Driver, QueryResultLike } from "./drivers/types";
import { currentDriver, setDriver } from "./drivers/current";

export class DataSource {
  private static _entities: EntityConstructor<any>[] = [];

  /**
   * Installs the database engine.
   *
   * The driver carries its own connection settings, so nothing here knows what
   * a host or a password is; swapping Postgres for another engine is swapping
   * this one argument.
   *
   * @example
   * import { PgDriver } from "@ecosy/orm/drivers/pg";
   *
   * DataSource.driver(PgDriver({ host, user, password, database }));
   *
   * @param driver A driver instance, from `@ecosy/orm/drivers/*` or your own.
   */
  static driver(driver: Driver) {
    setDriver(driver);
    return this;
  }

  /** The installed driver. */
  static get current(): Driver {
    return currentDriver();
  }

  /** The dialect of the installed driver. */
  static get dialect() {
    return this.current.dialect;
  }

  /** Entities whose schema `initialize` should sync. */
  static entities(entities: EntityConstructor<any>[]) {
    this._entities = Array.from(new Set([...entities]));
    return this;
  }

  /**
   * Opens the connection and brings every registered entity's table up to date.
   *
   * @param driver Optional, as a shorthand for calling {@link DataSource.driver} first.
   */
  static async initialize(driver?: Driver) {
    if (driver) this.driver(driver);

    await this.current.connect();

    const { SchemaBuilder } = await import("./query-builder");
    const conn = new DataSource();
    const schemaBuilder = new SchemaBuilder(conn);

    for (const EntityClass of this._entities) {
      if (EntityClass.entityName && EntityClass.schema) {
        try {
          await schemaBuilder.syncSchema(EntityClass.entityName, EntityClass.schema);
        } catch (error) {
          console.error(`[DB] Failed to sync schema for ${EntityClass.entityName}:`, error);
          throw error;
        }
      }
    }

    return conn;
  }

  /** Closes the pool. */
  static end() {
    return this.current.end();
  }

  /**
   * Opens a transaction on a connection taken out of the pool.
   *
   * Called with a function, the transaction is committed when it returns and
   * rolled back if it throws — the form to reach for, since it cannot leak a
   * connection. Called with nothing, the caller owns the lifecycle and must
   * finish it with `commit`, `rollback` or `release`.
   *
   * @example
   * await DataSource.transaction(async (tx) => {
   *   await files.using(tx).delete({ projectId });
   *   await projects.using(tx).delete({ id: projectId });
   * });
   *
   * @param fn Optional body to run inside the transaction.
   */
  static async transaction(): Promise<Transaction>;
  static async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  static async transaction<T>(fn?: (tx: Transaction) => Promise<T>): Promise<T | Transaction> {
    const connection = await this.current.acquire();

    try {
      await connection.query("BEGIN");
    } catch (error) {
      connection.release();
      throw error;
    }

    const tx = new Transaction(connection);

    if (!fn) return tx;

    try {
      const result = await fn(tx);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  /** Runs a statement on the pool. */
  async query<Row = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<Row>> {
    return DataSource.current.query<Row>(sql, params);
  }

  /** Instance form of {@link DataSource.transaction}. */
  transaction(): Promise<Transaction>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  transaction<T>(fn?: (tx: Transaction) => Promise<T>) {
    return fn ? DataSource.transaction(fn) : DataSource.transaction();
  }
}
