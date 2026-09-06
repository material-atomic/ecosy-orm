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
} from "./types";

/** Postgres dialect: `$n` placeholders, double-quoted identifiers, full RETURNING. */
const dialect: Dialect = {
  placeholder: (index) => `$${index}`,

  quote: (identifier) => `"${identifier.replace(/"/g, '""')}"`,

  supportsReturning: true,

  upsertClause: (conflictColumns, updateColumns) => {
    const target = conflictColumns.map((c) => dialect.quote(c)).join(", ");
    const assignments = updateColumns
      .map((c) => `${dialect.quote(c)} = EXCLUDED.${dialect.quote(c)}`)
      .join(", ");

    return `ON CONFLICT (${target}) DO UPDATE SET ${assignments}`;
  },

  alterNullable: (table, column, _type, notNull) =>
    `ALTER TABLE ${dialect.quote(table)} ALTER COLUMN ${dialect.quote(column)} ` +
    `${notNull ? "SET" : "DROP"} NOT NULL`,

  async tableExists(db, table) {
    const result = await db.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
      [table],
    );
    return Boolean(result.rows[0]?.exists);
  },

  async listColumns(db, table): Promise<ColumnInfo[]> {
    const result = await db.query(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = $1`,
      [table],
    );
    return result.rows.map((row: any) => ({
      name: row.column_name,
      nullable: row.is_nullable === "YES",
    }));
  },

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
export function PgDriver(config: PartialInput<PoolConfig>): Driver {
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

    async connect() {
      if (global[POOL]) return;

      const { Pool } = await import("pg");
      global[POOL] = new Pool(config as PoolConfig);
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
