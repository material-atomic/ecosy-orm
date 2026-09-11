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
  /**
   * The column's default as the engine renders it, or null for none.
   *
   * Rendered, not as written: Postgres stores `'html'` as `'html'::text` and
   * `left(gen_random_uuid()::text, 8)` as `"left"((gen_random_uuid())::text, 8)`.
   * Comparing it to a declaration takes {@link Dialect.renderDefaults}.
   */
  default?: string | null;
  /** The engine's own name for the type, for deciding whether it has to change. */
  type: string;
  /**
   * The size the engine is holding it at, when the type has one.
   *
   * `character varying` says nothing about whether the column is 120 or 255
   * wide, so without this a VARCHAR that changed length reads as unchanged and
   * the column silently keeps the old limit.
   */
  length?: number | null;
  precision?: number | null;
  scale?: number | null;
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
   * Whether a check constraint can be added without validating existing rows.
   *
   * Postgres has `NOT VALID`, and it is what lets a narrowed constraint apply
   * to a table whose old rows no longer satisfy it: everything written from
   * then on is checked, and the rows already there are left alone. Without it
   * the only outcomes are refusing the change or refusing to start.
   */
  readonly supportsUnvalidatedCheck: boolean;

  /**
   * A lock two processes can contend for by name, held for as long as the
   * connection that took it stays open.
   *
   * Optional: an engine without one leaves both undefined, and the caller says
   * out loud that concurrent runs are unguarded rather than pretending they are
   * not.
   *
   * The lock lives on a CONNECTION, so it only guards work done on that same
   * connection's session. Taking it through a pooled query and then working
   * elsewhere guards nothing — the connection goes back to the pool and the
   * lock with it.
   */
  advisoryLock?(key: string): string;
  advisoryUnlock?(key: string): string;

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
  /**
   * `predicate` names a partial unique index as the arbiter:
   * `ON CONFLICT (cols) WHERE predicate`. `updateWhere` limits which
   * conflicting rows are updated: `DO UPDATE SET … WHERE updateWhere`.
   */
  upsertClause(conflictColumns: string[], updateColumns: string[], predicate?: string, updateWhere?: string): string;

  /**
   * What a soft delete writes into the column. Default `CURRENT_TIMESTAMP`.
   * It should be the transaction's start time, so one delete and the deletes
   * its hooks make share a value, at a precision the driver returns intact.
   */
  softDeleteStamp?: string;

  /** `SET NOT NULL` versus `MODIFY COLUMN`. */
  alterNullable(table: string, column: string, type: string, notNull: boolean): string;

  /** `SET DEFAULT expression`, or `DROP DEFAULT` for null. Absent: defaults of existing columns are left alone. */
  alterDefault?(table: string, column: string, expression: string | null): string;

  /**
   * How the engine would render each declared default, in the same order.
   *
   * The only exact answer to "is this the default the entity declares" is to
   * let the engine rewrite the declaration the way it rewrote the stored one,
   * and compare rendering to rendering. Recording the declaration beside the
   * object — what checks do, in a COMMENT — works for a constraint, which the
   * ORM owns; a column comment belongs to whoever documents the column.
   *
   * Called on a connection held in a transaction, so an implementation may use
   * a temporary table dropped at commit.
   */
  renderDefaults?(db: Queryable, defaults: { type: string; expression: string }[]): Promise<string[]>;

  tableExists(db: Queryable, table: string): Promise<boolean>;
  listColumns(db: Queryable, table: string): Promise<ColumnInfo[]>;
  /** Index name to its definition, for deciding whether one has to be rebuilt. */
  listIndexes(db: Queryable, table: string): Promise<Record<string, string>>;
  /** Check-constraint name to its expression. */
  listChecks(
    db: Queryable,
    table: string,
  ): Promise<Record<string, { definition: string; declared: string | null; validated?: boolean }>>;

  /** Validates a check added NOT VALID, once every row satisfies it. */
  validateCheck?(table: string, name: string): string;

  /**
   * Records, next to the constraint, the expression the entity declared.
   *
   * The engine stores a check in its own canonical form — `IN (...)` comes back
   * as `= ANY (ARRAY[...])`, `BETWEEN` as two comparisons — and there is no way
   * to normalise the author's spelling forward into that form, nor the stored
   * form back. Comparing them at all is guesswork, and guessing wrong means
   * dropping and recreating the constraint on every boot.
   *
   * So the declaration is kept verbatim beside the constraint, and the
   * comparison is string equality against what was declared last time. Nothing
   * is normalised because nothing needs to be.
   *
   * Optional. An engine that cannot annotate a constraint leaves it undefined,
   * and sync then leaves existing checks alone rather than recreating them on a
   * comparison it cannot make.
   */
  describeCheck?(table: string, name: string, expression: string): string;
  /**
   * Indexes this table has that no constraint owns.
   *
   * A primary key and a unique constraint each carry an index, and those
   * cannot be dropped directly — the constraint owns them. Sync needs to know
   * which indexes are its own to remove before it removes any.
   */
  listOwnedIndexes(db: Queryable, table: string): Promise<string[]>;

  /**
   * Foreign keys on this table, as `column -> { name, definition }`.
   *
   * `definition` is the engine's own full rendering of the constraint —
   * referenced table and column AND the action clauses. Rebuilding it from
   * catalog columns instead loses `ON DELETE` and `ON UPDATE`, which makes
   * every constraint that has one look different from itself on the next
   * comparison.
   *
   * Keyed by the column that carries it rather than by constraint name,
   * because the entity declares `references` on a column and knows nothing
   * about what the engine chose to call the constraint.
   *
   * A composite foreign key spans several columns and has no single carrier,
   * so it is not reported here — the column-level `references` in a schema
   * cannot express one either, and reporting half of it would invite sync to
   * "fix" a constraint it does not understand.
   */
  listForeignKeys(
    db: Queryable,
    table: string,
  ): Promise<Record<string, { name: string; definition: string }>>;

  /**
   * `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (col) REFERENCES target`.
   *
   * `validate: false` adds it unvalidated where the engine allows it, so rows
   * already there are left alone and everything written from now on is
   * checked — the same escape the check constraints use.
   */
  addForeignKey(
    table: string,
    column: string,
    target: string,
    name: string,
    validate?: boolean,
  ): string;

  /** `ALTER TABLE ... DROP CONSTRAINT`. */
  dropForeignKey(table: string, name: string): string;

  /** Column name to the name of the single-column UNIQUE constraint on it. */
  listUniqueConstraints?(db: Queryable, table: string): Promise<Record<string, string>>;
  addUnique?(table: string, name: string, column: string): string;
  /** Drops a column, with whatever it held. */
  dropColumn(table: string, column: string): string;
  /** Renames a column, keeping what it holds. */
  renameColumn(table: string, from: string, to: string): string;
  /** Changes a column's type in place. */
  alterType(table: string, column: string, type: string): string;
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
/** How much of the schema sync a driver is configured to do. */
export interface SyncOptions {
  /**
   * Whether to keep a snapshot of each entity's shape, in `_ecosy_schema`.
   *
   * It buys one thing: a column rename keeps its data. The live database only
   * ever knew column names, so a rename and a drop-plus-add are the same two
   * facts to it; a snapshot also records the **property key**, which survives
   * the rename and is what tells them apart.
   *
   * Off by default. It is a table this package creates and writes on every
   * sync, and a project that never renames a column gets nothing for it.
   */
  snapshot?: boolean | undefined;
}

export interface Driver extends Queryable {
  /** For error messages and logs — `"pg"`, `"mariadb"`. */
  readonly name: string;

  readonly dialect: Dialect;

  /** Set where the connection is configured — see {@link SyncOptions}. */
  readonly sync: SyncOptions;

  /** Opens the pool. Called once by {@link DataSource.initialize}. */
  connect(): Promise<void>;

  /** Closes the pool and every connection in it. */
  end(): Promise<void>;

  /** Takes one connection out of the pool, for a transaction to hold. */
  acquire(): Promise<DriverConnection>;
}
