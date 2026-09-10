/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PoolConfig } from "pg";
import type { PartialInput } from "../optional";
import type {
  ColumnInfo,
  Dialect,
  Driver,
  DriverConnection,
  Queryable,
  QueryResultLike,
  SyncOptions,
} from "./types";

/** Postgres dialect: `$n` placeholders, double-quoted identifiers, full RETURNING. */
const dialect: Dialect = {
  placeholder: (index) => `$${index}`,

  quote: (identifier) => `"${identifier.replace(/"/g, '""')}"`,

  supportsReturning: true,
  supportsUnvalidatedCheck: true,

  /* `hashtext` maps the name onto the bigint the lock functions take, so
     callers name a lock instead of inventing a number and hoping nobody else
     picked it. */
  advisoryLock: (key) => `SELECT pg_advisory_lock(hashtext('${key.replace(/'/g, "''")}'))`,
  advisoryUnlock: (key) => `SELECT pg_advisory_unlock(hashtext('${key.replace(/'/g, "''")}'))`,

  upsertClause: (conflictColumns, updateColumns) => {
    const target = conflictColumns.map((c) => dialect.quote(c)).join(", ");

    /* Every inserted column is a conflict column, so there is nothing left to
       assign. An empty SET is a syntax error, and the obvious repair — DO
       NOTHING — is worse than it looks: DO NOTHING returns no row, so RETURNING
       yields nothing on conflict and `upsert()` hands back undefined for a
       signature that promises an Entity. That trades a syntax error thrown on
       the first run for an undefined appearing only when a row already existed.
       
       Assigning a conflict column to itself keeps the row locked, matched and
       RETURNED, which is the contract callers were given. It writes nothing
       new: EXCLUDED holds the value that conflicted with the identical stored
       one. */
    const assignments = updateColumns.length
      ? updateColumns.map((c) => `${dialect.quote(c)} = EXCLUDED.${dialect.quote(c)}`).join(", ")
      : `${dialect.quote(conflictColumns[0]!)} = EXCLUDED.${dialect.quote(conflictColumns[0]!)}`;

    return `ON CONFLICT (${target}) DO UPDATE SET ${assignments}`;
  },

  alterNullable: (table, column, _type, notNull) =>
    `ALTER TABLE ${dialect.quote(table)} ALTER COLUMN ${dialect.quote(column)} ` +
    `${notNull ? "SET" : "DROP"} NOT NULL`,

  /**
   * Both lookups are scoped to the search path.
   *
   * `information_schema` spans every schema the connection can see, so an
   * unqualified `table_name = $1` matches things that are not yours: an entity
   * named `tables`, `columns`, `domains`, `routines` or `sequences` finds
   * information_schema's own view of that name and reports as existing. CREATE
   * TABLE is then skipped and the ALTER that follows dies with 42P01 on a
   * table that was never made.
   */
  async tableExists(db, table) {
    const result = await db.query(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_name = $1
           AND table_schema = ANY(current_schemas(false))
       )`,
      [table],
    );
    return Boolean(result.rows[0]?.exists);
  },

  async listColumns(db, table): Promise<ColumnInfo[]> {
    const result = await db.query(
      `SELECT column_name, is_nullable, data_type,
              character_maximum_length, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_name = $1
          AND table_schema = ANY(current_schemas(false))`,
      [table],
    );
    return result.rows.map((row: any) => ({
      name: row.column_name,
      nullable: row.is_nullable === "YES",
      type: String(row.data_type),
      length: row.character_maximum_length ?? null,
      precision: row.numeric_precision ?? null,
      scale: row.numeric_scale ?? null,
    }));
  },

  /* Indexes that exist in their own right. One backing a primary key or a
     unique constraint belongs to that constraint and is dropped with it, never
     on its own. */
  /**
   * Single-column foreign keys, keyed by the column that carries them.
   *
   * `conkey` is the array of column numbers the constraint covers, so
   * `array_length(conkey, 1) = 1` keeps this to the ones a column-level
   * `references` could have produced. `confrelid::regclass` gives the target
   * table back in the form the schema writes it.
   */
  async listForeignKeys(db, table): Promise<Record<string, { name: string; target: string }>> {
    const result = await db.query(
      `SELECT c.conname,
              a.attname AS column_name,
              c.confrelid::regclass::text AS target_table,
              fa.attname AS target_column
         FROM pg_constraint c
         JOIN pg_attribute a  ON a.attrelid  = c.conrelid  AND a.attnum  = c.conkey[1]
         JOIN pg_attribute fa ON fa.attrelid = c.confrelid AND fa.attnum = c.confkey[1]
        WHERE c.conrelid = $1::regclass
          AND c.contype = 'f'
          AND array_length(c.conkey, 1) = 1`,
      [table],
    );

    return Object.fromEntries(
      result.rows.map((row: any) => [
        row.column_name,
        { name: row.conname, target: `${row.target_table}(${row.target_column})` },
      ]),
    );
  },

  addForeignKey: (table, column, target, name, validate = true) =>
    `ALTER TABLE ${dialect.quote(table)} ADD CONSTRAINT ${dialect.quote(name)} ` +
    `FOREIGN KEY (${dialect.quote(column)}) REFERENCES ${target}` +
    (validate ? "" : " NOT VALID"),

  dropForeignKey: (table, name) =>
    `ALTER TABLE ${dialect.quote(table)} DROP CONSTRAINT ${dialect.quote(name)}`,

  async listOwnedIndexes(db, table): Promise<string[]> {
    const result = await db.query(
      `SELECT i.indexname
         FROM pg_indexes i
         LEFT JOIN pg_constraint c
           ON c.conname = i.indexname
          AND c.conrelid = i.tablename::regclass
        WHERE i.tablename = $1
          AND c.conname IS NULL`,
      [table],
    );
    return result.rows.map((row: any) => String(row.indexname));
  },

  dropColumn: (table, column) =>
    `ALTER TABLE ${dialect.quote(table)} DROP COLUMN ${dialect.quote(column)}`,

  renameColumn: (table, from, to) =>
    `ALTER TABLE ${dialect.quote(table)} RENAME COLUMN ${dialect.quote(from)} TO ${dialect.quote(to)}`,

  /* `USING` because Postgres will not change a type it cannot cast implicitly,
     and an explicit cast is the difference between a column that converts and
     one that refuses. */
  alterType: (table, column, type) =>
    `ALTER TABLE ${dialect.quote(table)} ALTER COLUMN ${dialect.quote(column)} ` +
    `TYPE ${type} USING ${dialect.quote(column)}::${type}`,

  async listIndexes(db, table) {
    const result = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`,
      [table],
    );
    return Object.fromEntries(result.rows.map((row: any) => [row.indexname, row.indexdef]));
  },

  async listChecks(db, table) {
    const result = await db.query(
      `SELECT conname, pg_get_constraintdef(oid) AS condef
         FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'c'`,
      [table],
    );
    return Object.fromEntries(result.rows.map((row: any) => [row.conname, row.condef]));
  },
};

/**
 * The Postgres driver, built on `pg`.
 *
 * `pg` is an optional peer dependency and is loaded by a dynamic import inside
 * {@link PgDriver.connect}, so an app on another engine never resolves it —
 * which is also why this module is not exported from the package root.
 *
 * @example
 * import { PgDriver } from "@ecosy/orm/drivers/pg";
 *
 * const driver = PgDriver({ host: "localhost", user: "app", database: "app" });
 *
 * @param config Passed to `new Pool()` untouched.
 *
 * Typed as {@link PartialInput} rather than `PoolConfig` itself: a config is
 * usually assembled from the environment, where every value is
 * `string | undefined`, and `pg`'s own optional properties refuse that under
 * `exactOptionalPropertyTypes`. `pg` is not ours to change, so the relaxation
 * happens on the way in.
 */
export interface PgDriverConfig extends PartialInput<PoolConfig> {
  /** See {@link SyncOptions}. Not passed to `pg`. */
  sync?: SyncOptions | undefined;
}

export function PgDriver(config: PgDriverConfig): Driver {
  /* Split before the rest reaches `new Pool()`, which is handed the object
     untouched and would carry an option it knows nothing about. */
  const { sync = {}, ...poolConfig } = config;
  /* Held on globalThis under a Symbol so a hot reload reuses the pool instead
     of opening a second one and quietly doubling the connection count. */
  const POOL = Symbol.for("@ecosy/orm:pg-pool");
  const global = globalThis as typeof globalThis & { [POOL]?: any };

  const pool = () => {
    if (!global[POOL]) {
      throw new Error("[PgDriver] Not connected. DataSource.initialize() opens the pool.");
    }
    return global[POOL];
  };

  return {
    name: "pg",
    dialect,
    sync,

    async connect() {
      if (global[POOL]) return;

      const { Pool } = await import("pg");
      global[POOL] = new Pool(poolConfig as PoolConfig);
    },

    async end() {
      if (!global[POOL]) return;

      await global[POOL].end();
      global[POOL] = undefined;
    },

    async query<Row = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<Row>> {
      const result = await pool().query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? 0 };
    },

    async acquire(): Promise<DriverConnection> {
      const client = await pool().connect();

      return {
        async query<Row = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<Row>> {
          const result = await client.query(sql, params);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        release: () => client.release(),
      };
    },
  };
}

export type { Queryable };
