/* eslint-disable @typescript-eslint/no-explicit-any */
import { currentLogger } from "../logger";
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

  softDeleteStamp: "date_trunc('milliseconds', now())",

  upsertClause: (conflictColumns, updateColumns, predicate, updateWhere) => {
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

    return `ON CONFLICT (${target})${predicate ? ` WHERE ${predicate}` : ""} DO UPDATE SET ${assignments}` +
      (updateWhere ? ` WHERE ${updateWhere}` : "");
  },

  alterNullable: (table, column, _type, notNull) =>
    `ALTER TABLE ${dialect.quote(table)} ALTER COLUMN ${dialect.quote(column)} ` +
    `${notNull ? "SET" : "DROP"} NOT NULL`,

  /* Catalogue-only: neither form rewrites the table or touches a row. A new
     default applies to later writes; rows already NULL are filled by sync's
     tighten phase, not by this. */
  alterDefault: (table, column, expression) =>
    `ALTER TABLE ${dialect.quote(table)} ALTER COLUMN ${dialect.quote(column)} ` +
    (expression === null ? "DROP DEFAULT" : `SET DEFAULT ${expression}`),

  /* A throwaway table with the declared defaults on columns of the declared
     types, read back through the same pg_get_expr that fills
     information_schema.columns.column_default. Same function, same type
     context, so equal declarations render equal. ON COMMIT DROP keeps it from
     outliving the transaction the caller holds it in. */
  async renderDefaults(db, defaults) {
    if (!defaults.length) return [];
    /* Named per call and dropped straight after: the caller's transaction may
       sync several entities, and ON COMMIT DROP alone would leave the first
       probe in the way of the second. */
    const probe = `_ecosy_default_probe_${Math.random().toString(36).slice(2, 10)}`;
    await db.query(
      `CREATE TEMP TABLE ${probe} (` +
        defaults.map((d, i) => `c${i} ${d.type} DEFAULT ${d.expression}`).join(", ") +
        `) ON COMMIT DROP`,
    );
    try {
      const result = await db.query(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS expr
           FROM pg_attrdef d
           JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = 'pg_temp.${probe}'::regclass
          ORDER BY a.attnum`,
      );
      return result.rows.map((row: any) => String(row.expr));
    } finally {
      await db.query(`DROP TABLE IF EXISTS pg_temp.${probe}`);
    }
  },

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
      `SELECT column_name, is_nullable, data_type, column_default,
              character_maximum_length, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_name = $1
          AND table_schema = ANY(current_schemas(false))`,
      [table],
    );
    return result.rows.map((row: any) => ({
      name: row.column_name,
      nullable: row.is_nullable === "YES",
      default: row.column_default ?? null,
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
  async listForeignKeys(db, table): Promise<Record<string, { name: string; definition: string }>> {
    const result = await db.query(
      `SELECT c.conname,
              a.attname AS column_name,
              pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.conrelid = $1::regclass
          AND c.contype = 'f'
          AND array_length(c.conkey, 1) = 1`,
      [table],
    );

    return Object.fromEntries(
      result.rows.map((row: any) => [
        row.column_name,
        { name: row.conname, definition: row.definition },
      ]),
    );
  },

  addForeignKey: (table, column, target, name, validate = true) =>
    `ALTER TABLE ${dialect.quote(table)} ADD CONSTRAINT ${dialect.quote(name)} ` +
    `FOREIGN KEY (${dialect.quote(column)}) REFERENCES ${target}` +
    (validate ? "" : " NOT VALID"),

  describeCheck: (table, name, expression) =>
    `COMMENT ON CONSTRAINT ${dialect.quote(name)} ON ${dialect.quote(table)} ` +
    `IS '${expression.replace(/'/g, "''")}'`,

  dropForeignKey: (table, name) =>
    `ALTER TABLE ${dialect.quote(table)} DROP CONSTRAINT ${dialect.quote(name)}`,

  /* Single-column UNIQUE constraints only: that is what `unique: true` on a
     column creates. A multi-column one came from somewhere else, and is not
     this reconciliation's to touch. */
  async listUniqueConstraints(db, table) {
    const result = await db.query(
      `SELECT c.conname, a.attname
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.conrelid = $1::regclass AND c.contype = 'u' AND array_length(c.conkey, 1) = 1`,
      [table],
    );
    return Object.fromEntries(result.rows.map((row: any) => [row.attname, row.conname]));
  },

  validateCheck: (table, name) =>
    `ALTER TABLE ${dialect.quote(table)} VALIDATE CONSTRAINT ${dialect.quote(name)}`,

  addUnique: (table, name, column) =>
    `ALTER TABLE ${dialect.quote(table)} ADD CONSTRAINT ${dialect.quote(name)} UNIQUE (${dialect.quote(column)})`,

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
    /* `pg_description` carries what the entity declared, put there by
       `describeCheck` when the constraint was created. `pg_get_constraintdef`
       is the engine's rewritten form, kept for error messages — never for
       deciding whether anything changed. */
    const result = await db.query(
      `SELECT c.conname,
              c.convalidated,
              pg_get_constraintdef(c.oid) AS condef,
              d.description AS declared
         FROM pg_constraint c
         LEFT JOIN pg_description d
           ON d.objoid = c.oid
          AND d.classoid = 'pg_constraint'::regclass
        WHERE c.conrelid = $1::regclass AND c.contype = 'c'`,
      [table],
    );

    return Object.fromEntries(
      result.rows.map((row: any) => [
        row.conname,
        { definition: row.condef, declared: row.declared ?? null, validated: row.convalidated !== false },
      ]),
    );
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


/**
 * A one-line, password-free description of where a config points.
 *
 * Falls back to naming the defaults rather than printing blanks: "wherever
 * node-postgres defaults to" is the fact that explains a connection to
 * localhost nobody asked for, and blanks would hide it.
 */
function describeTarget(config: Record<string, unknown>): string {
  const url = typeof config.connectionString === "string" ? config.connectionString : "";

  if (url) {
    try {
      const parsed = new URL(url);
      const database = parsed.pathname.replace(/^\//, "") || "?";
      return `${parsed.hostname}:${parsed.port || "5432"}/${database} as ${parsed.username || "?"}`;
    } catch {
      return "a connection string that does not parse as a URL";
    }
  }

  if (config.host || config.database || config.user) {
    return `${String(config.host ?? "?")}:${String(config.port ?? "?")}/` +
      `${String(config.database ?? "?")} as ${String(config.user ?? "?")}`;
  }

  return "wherever node-postgres defaults to — nothing here named a host";
}

export function PgDriver(config: PgDriverConfig): Driver {
  /* Split before the rest reaches `new Pool()`, which is handed the object
     untouched and would carry an option it knows nothing about. */
  const { sync = {}, ...poolConfig } = config;

  /* An empty `connectionString` is not the same as no `connectionString`.
   *
   * Omitting it says "I am configuring by host and user". Passing an empty one
   * says "I read a URL from somewhere and got nothing" — and node-postgres
   * treats the two identically: anything falsy is ignored, the discrete fields
   * take over, and whatever they do not supply comes from PG* environment
   * variables and then from defaults ending at localhost:5432.
   *
   * So a missing DATABASE_URL becomes a connection attempt to the process's own
   * machine, and the error names 127.0.0.1 — a place that has nothing to do
   * with the mistake. In a container it is worse: localhost is the container,
   * so the report is about a host that could never have been right.
   *
   * The key being present is the evidence that a URL was expected. Refusing
   * here costs nothing and puts the message where the cause is. */
  if ("connectionString" in poolConfig && !String(poolConfig.connectionString ?? "").trim()) {
    throw new Error(
      "[PgDriver] `connectionString` was given but is empty — the value it was read " +
        "from is unset. Leave the option out entirely to configure by host, user, " +
        "password, database and port instead; passing it empty falls through to " +
        "localhost, which is almost never what was meant.",
    );
  }
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
      const created = new Pool(poolConfig as PoolConfig);

      /* Says what was configured, which is the thing worth seeing in a log at
         startup: a connection that was never told where to go announces itself
         here, instead of only in a refused-connection error naming an address
         nobody chose.

         Read from the config rather than from the pool: `Pool.options` keeps
         what it was handed, not what node-postgres resolves — a URL is parsed
         per client, so asking the pool would report nothing at all. Where the
         config says nothing either, the honest answer is that the defaults
         decide, and the line says so. */
      currentLogger().info(`[PgDriver] connecting to ${describeTarget(poolConfig)}`);

      global[POOL] = created;
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
