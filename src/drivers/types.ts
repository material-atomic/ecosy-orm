/* eslint-disable @typescript-eslint/no-explicit-any */

/** The shape every driver reduces a result set to. */
export interface QueryResultLike<Row = any> {
  rows: Row[];
  rowCount: number;
}

/** Anything a statement can be run against. */
export interface Queryable {
  query<Row = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<Row>>;
}

/** One connection held out of the pool, for a transaction. */
export interface DriverConnection extends Queryable {
  release(): void;
}

export interface ColumnInfo {
  name: string;
  nullable: boolean;
}

/**
 * Everything about a database that is not plain SQL.
 *
 * Kept apart from {@link Driver} because the two answer different questions:
 * a driver knows how to reach the server, a dialect knows what to say to it.
 * A pool for the same engine can be swapped without touching either.
 */
export interface Dialect {
  /** `$1` on Postgres, `?` on MySQL and MariaDB. `index` is 1-based. */
  placeholder(index: number): string;

  /** Wraps an identifier so a reserved word or an odd name is still legal. */
  quote(identifier: string): string;

  /**
   * Whether `INSERT ... RETURNING` can be relied on.
   *
   * When false the builder issues the write and reads the row back, which
   * costs a round trip — MariaDB has RETURNING for INSERT and DELETE but not
   * for UPDATE, and MySQL has none at all.
   */
  readonly supportsReturning: boolean;

  /**
   * The upsert tail.
   *
   * Both halves differ by engine, not just the keyword: Postgres names the
   * incoming row `EXCLUDED`, MySQL and MariaDB use `VALUES(col)` or a row
   * alias — so the dialect builds the assignments rather than receiving them.
   *
   * @param conflictColumns Columns the conflict is detected on, already
   * mapped to their database names.
   * @param updateColumns Columns to overwrite, already mapped.
   */
  upsertClause(conflictColumns: string[], updateColumns: string[]): string;

  /** `SET NOT NULL` versus `MODIFY COLUMN`. */
  alterNullable(table: string, column: string, type: string, notNull: boolean): string;

  tableExists(db: Queryable, table: string): Promise<boolean>;
  listColumns(db: Queryable, table: string): Promise<ColumnInfo[]>;
  /** Index name to its definition, for deciding whether one has to be rebuilt. */
  listIndexes(db: Queryable, table: string): Promise<Record<string, string>>;
  /** Check-constraint name to its expression. */
  listChecks(db: Queryable, table: string): Promise<Record<string, string>>;
}

/**
 * A database engine, injected into {@link DataSource}.
 *
 * Built-in drivers live on their own subpaths and load their client package
 * through a dynamic import, so installing this package does not drag in a
 * driver nobody uses:
 *
 * @example
 * import { DataSource } from "@ecosy/orm";
 * import { PgDriver } from "@ecosy/orm/drivers/pg";
 *
 * await DataSource
 *   .driver(PgDriver({ host, user, password, database }))
 *   .entities([UserEntity])
 *   .initialize();
 */
export interface Driver extends Queryable {
  /** For error messages and logs — `"pg"`, `"mariadb"`. */
  readonly name: string;

  readonly dialect: Dialect;

  /** Opens the pool. Called once by {@link DataSource.initialize}. */
  connect(): Promise<void>;

  /** Closes the pool and every connection in it. */
  end(): Promise<void>;

  /** Takes one connection out of the pool, for a transaction to hold. */
  acquire(): Promise<DriverConnection>;
}
