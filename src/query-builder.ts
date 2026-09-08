/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import { currentLogger } from "./logger";
import type { FindOptions, FindWhereOptions, ObjectWhere, SchemaOptions } from "./repository";
import type { Entity as BaseEntity } from "./entity";
import type { ColumnInfo, Dialect, Queryable, SyncOptions } from "./drivers/types";
import { currentDialect, currentDriver } from "./drivers/current";


export class QueryBuilder<Entity extends BaseEntity> {
  constructor(
    public entityName: string,
    public schema: SchemaOptions,
    /** Defaults to the installed driver's dialect. */
    private dialect: Dialect = currentDialect(),
  ) {}

  /** Quotes an identifier the way this engine expects. */
  private q(identifier: string) {
    return this.dialect.quote(identifier);
  }

  private dbCol(tsKey: string): string {
    return this.schema.columns[tsKey]?.name || tsKey;
  }

  /** Keys the entity actually declares. A typo never reaches SQL as a column name. */
  private known(tsKeys: string[]): string[] {
    return tsKeys.filter((key) => key in this.schema.columns);
  }

  /**
   * Encodes a value for the column it is going into.
   *
   * `pg` turns a plain object into JSON but turns a JS array into a Postgres
   * array literal `{a,b}`, which `jsonb` rejects with "invalid input syntax for
   * type json". The column type is declared, so the builder knows which values
   * need serialising and does it for both shapes — reading stays symmetric,
   * since the driver parses jsonb back into real objects and arrays.
   */
  private encode(tsKey: string, value: any) {
    const type = (this.schema.columns[tsKey]?.type || "").toUpperCase();
    const isJson = type === "JSON" || type === "JSONB";

    if (!isJson || value === null || value === undefined || typeof value === "string") {
      return value;
    }

    return JSON.stringify(value);
  }

  private withEntity(tsKey: string) {
    return `${this.q(this.entityName)}.${this.q(this.dbCol(tsKey))}`;
  }

  private getQueryColumns() {
    return Object.keys(this.schema.columns).map((tsKey) => {
      return `${this.q(this.entityName)}.${this.q(this.dbCol(tsKey))} AS ${this.q(tsKey)}`;
    }).join(", ");
  }

  /**
   * The RETURNING tail, or nothing on an engine without it.
   *
   * A caller that needs the row back has to read it separately there; saying
   * RETURNING to MySQL is a syntax error rather than a missing field.
   */
  private returning() {
    return this.dialect.supportsReturning ? ` RETURNING ${this.getQueryColumns()}` : "";
  }

  private buildWhereSql(where: FindWhereOptions<Entity>, params: any[]): string {
    if (Array.isArray(where)) {
      const conditions = where.map((w: FindWhereOptions<Entity>) => this.buildWhereSql(w, params)).filter(Boolean);
      return conditions.length ? `(${conditions.join(" OR ")})` : "";
    }

    if (where && typeof where === "object" && "type" in where && where.type === "AND") {
      const conditions = (where as any).conditions.map((w: FindWhereOptions<Entity>) => this.buildWhereSql(w, params)).filter(Boolean);
      return conditions.length ? `(${conditions.join(" AND ")})` : "";
    }

    if (where && typeof where === "object" && "type" in where && where.type === "OR") {
      const conditions = (where as any).conditions.map((w: FindWhereOptions<Entity>) => this.buildWhereSql(w, params)).filter(Boolean);
      return conditions.length ? `(${conditions.join(" OR ")})` : "";
    }

    const objectWhere = where as ObjectWhere<Entity>;
    const conditions = Object.entries(objectWhere || {}).map(([tsKey, value]) => {
      /* `undefined` means "no condition on this field", the way every other ORM
         reads it. Pushing it as a parameter made it a null comparison, which is
         never true — a filter the caller did not ask for and cannot see. */
      if (value === undefined) return "";

      /* `x = NULL` is UNKNOWN in SQL and never true, so a null here has to
         become IS NULL. It used to compile to a placeholder with a null
         parameter: no error, no rows, and the same silence from update and
         delete, which share this method. `{ deletedAt: null }` type-checks on
         any nullable column, so the type system was actively inviting it. */
      if (value === null) return `${this.withEntity(tsKey)} IS NULL`;

      if (typeof value === "object" && "type" in value) {
        const v = value as any;
        if (v.type === "NOT") {
          if (v.value === null) return `${this.withEntity(tsKey)} IS NOT NULL`;
          params.push(v.value);
          return `${this.withEntity(tsKey)} != ${this.dialect.placeholder(params.length)}`;
        }
        if (v.type === "LIKE") {
          params.push(v.value);
          return `${this.withEntity(tsKey)} LIKE ${this.dialect.placeholder(params.length)}`;
        }
        if (v.type === "BETWEEN") {
          params.push(v.value[0], v.value[1]);
          return `${this.withEntity(tsKey)} BETWEEN ${this.dialect.placeholder(params.length - 1)} AND ${this.dialect.placeholder(params.length)}`;
        }
      }
      params.push(this.encode(tsKey, value));
      return `${this.withEntity(tsKey)} = ${this.dialect.placeholder(params.length)}`;
    }).filter(Boolean);

    return conditions.length ? conditions.join(" AND ") : "";
  }

  buildSelect(options: FindOptions<Entity>): { sql: string, params: any[] } {
    const params: any[] = [];
    const result: string[] = [];
    const where = this.buildWhereSql(options.where ?? ({} as any), params);
    
    if (where) {
      result.push(`WHERE ${where}`);
    }

    /* LIMIT without an order is not deterministic: the engine may return any N
       rows that match, and is free to return different ones next time. Keys are
       whitelisted against the schema, so an order clause cannot carry SQL in. */
    const order = Object.entries(options.order ?? {})
      .filter(([tsKey]) => tsKey in this.schema.columns)
      .map(([tsKey, dir]) => `${this.withEntity(tsKey)} ${dir === "DESC" ? "DESC" : "ASC"}`);

    if (order.length) {
      result.push(`ORDER BY ${order.join(", ")}`);
    }

    if (options.limit) {
      result.push(`LIMIT ${options.limit}`);
    }
    if (options.offset) {
      result.push(`OFFSET ${options.offset}`);
    }

    const selectSql = `SELECT ${this.getQueryColumns()} FROM ${this.entityName}`;
    const sql = [selectSql, result.join(" ")].filter(Boolean).join(" ");
    return { sql, params };
  }

  buildInsert(arr: PartialInput<Entity>[]): { sql: string, params: any[] } {
    if (!arr.length) return { sql: "", params: [] };
    /* The UNION of every row's keys, not the first row's. Taking row 0 dropped
       a field that only later rows carried, and turned a field missing from a
       later row into NULL — which surfaced as a not-null violation naming the
       column rather than the real cause, a row whose shape differed. */
    const tsKeys = this.known([...new Set(arr.flatMap((row) => Object.keys(row)))]);
    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        params.push(this.encode(c, (obj as any)[c]));
        return `${this.dialect.placeholder(params.length)}`;
      }).join(", ")})`;
    }).join(", ");
    
    const columns = tsKeys.map(c => this.q(this.dbCol(c))).join(", ");
    const sql = `INSERT INTO ${this.entityName} (${columns}) VALUES ${values}` + this.returning();

    return { sql, params };
  }

  buildUpdate(where: FindWhereOptions<Entity>, data: PartialInput<Entity>): { sql: string, params: any[] } {
    const params: any[] = [];
    const assignments = Object.entries(data)
      .filter(([tsKey]) => tsKey in this.schema.columns)
      .map(([tsKey, v]) => {
        params.push(this.encode(tsKey, v));
        return `${this.q(this.dbCol(tsKey))} = ${this.dialect.placeholder(params.length)}`;
      }).join(", ");
    const condition = this.buildWhereSql(where, params);
    
    const sql = [
      `UPDATE ${this.entityName} SET ${assignments}`,
      condition ? `WHERE ${condition}` : "",
    ].filter(Boolean).join(" ");

    return { sql, params };
  }

  buildDelete(where: FindWhereOptions<Entity>): { sql: string, params: any[] } {
    const params: any[] = [];
    const condition = this.buildWhereSql(where, params);
    
    const sql = [
      `DELETE FROM ${this.entityName}`,
      condition ? `WHERE ${condition}` : "",
    ].filter(Boolean).join(" ");

    return { sql, params };
  }

  buildUpsert(arr: PartialInput<Entity>[], conflictColumns: string[]): { sql: string, params: any[] } {
    if (!arr.length) return { sql: "", params: [] };
    /* The UNION of every row's keys, not the first row's. Taking row 0 dropped
       a field that only later rows carried, and turned a field missing from a
       later row into NULL — which surfaced as a not-null violation naming the
       column rather than the real cause, a row whose shape differed. */
    const tsKeys = this.known([...new Set(arr.flatMap((row) => Object.keys(row)))]);
    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        params.push(this.encode(c, (obj as any)[c]));
        return `${this.dialect.placeholder(params.length)}`;
      }).join(", ")})`;
    }).join(", ");
    
    const columns = tsKeys.map(c => this.q(this.dbCol(c))).join(", ");
    const insertSql = `INSERT INTO ${this.entityName} (${columns}) VALUES ${values}`;

    const dbConflictColumns = conflictColumns.map(c => this.dbCol(c));

    const updateColumns = tsKeys
      .filter(c => !conflictColumns.includes(c))
      .map(c => this.dbCol(c));

    const sql = `${insertSql} ${this.dialect.upsertClause(dbConflictColumns, updateColumns)}${this.returning()}`;
    
    return { sql, params };
  }
}

/** The installed driver's sync options, or none when no driver is installed. */
function safeSyncOptions(): SyncOptions {
  try {
    return currentDriver().sync ?? {};
  } catch {
    return {};
  }
}

export class SchemaBuilder {
  /**
   * @param connection Where to run the statements.
   * @param dialect How to phrase them. Every engine-specific query — does this
   * table exist, what indexes does it have — now belongs to the dialect, so
   * this class contains no SQL that only one database understands.
   */
  constructor(
    private connection: Queryable,
    /** Defaults to the installed driver's dialect. */
    private dialect: Dialect = currentDialect(),
    /**
     * Defaults to the installed driver's. Passed explicitly only when building
     * statements for an engine other than the one in use, where there is no
     * driver to read it from.
     */
    private sync: SyncOptions = safeSyncOptions(),
  ) {}

  private columnDefinition(opt: any, withPrimaryKey: boolean) {
    let def = `${this.dialect.quote(opt.name)} ${opt.type}`;
    if (withPrimaryKey && opt.primaryKey) def += " PRIMARY KEY";
    if (opt.unique) def += " UNIQUE";
    if (opt.notNull) def += " NOT NULL";
    if (opt.default) def += ` DEFAULT ${opt.default}`;
    if (opt.references) def += ` REFERENCES ${opt.references}`;
    return def;
  }

  private indexStatement(entityName: string, schema: SchemaOptions, idx: any) {
    const unique = idx.unique ? "UNIQUE " : "";
    const cols = idx.columns
      .map((c: string) => this.dialect.quote(schema.columns[c]?.name || c))
      .join(", ");
    return `CREATE ${unique}INDEX ${this.dialect.quote(idx.name)} ON ${this.dialect.quote(entityName)} (${cols})`;
  }

  private checkStatement(entityName: string, chk: any, validate = true) {
    /* `NOT VALID` enforces the constraint on everything written from now on
       and leaves the rows already there alone — see `supportsUnvalidatedCheck`. */
    const tail = validate || !this.dialect.supportsUnvalidatedCheck ? "" : " NOT VALID";

    return (
      `ALTER TABLE ${this.dialect.quote(entityName)} ADD CONSTRAINT ` +
      `${this.dialect.quote(chk.name)} CHECK (${chk.expression})${tail}`
    );
  }

  /** Where the last synced shape of each entity is kept. */
  private static readonly SNAPSHOT_TABLE = "_ecosy_schema";

  /**
   * Remembers what each entity looked like at the last sync.
   *
   * The live database cannot answer "was this a rename?" — it only ever knew
   * column names, so a renamed column and a dropped-plus-added pair are the
   * same two facts. A snapshot knows one thing more: the **property key** the
   * entity used. That key survives a column rename, and is what makes the two
   * cases distinguishable at all.
   */
  private async snapshot(entityName: string): Promise<SchemaOptions | null> {
    if (!this.sync.snapshot) return null;

    await this.connection.query(
      `CREATE TABLE IF NOT EXISTS ${this.dialect.quote(SchemaBuilder.SNAPSHOT_TABLE)} (
         entity TEXT PRIMARY KEY,
         shape TEXT NOT NULL,
         synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );

    const result = await this.connection.query(
      `SELECT shape FROM ${this.dialect.quote(SchemaBuilder.SNAPSHOT_TABLE)} WHERE entity = $1`,
      [entityName],
    );

    if (!result.rows.length) return null;

    try {
      return JSON.parse(result.rows[0].shape) as SchemaOptions;
    } catch {
      /* Hand-edited, or written by a version that stored something else. A
         missing snapshot costs rename detection and nothing more. */
      return null;
    }
  }

  private async saveSnapshot(entityName: string, schema: SchemaOptions) {
    if (!this.sync.snapshot) return;

    await this.connection.query(
      `INSERT INTO ${this.dialect.quote(SchemaBuilder.SNAPSHOT_TABLE)} (entity, shape, synced_at)
       VALUES ($1, $2, now())
       ON CONFLICT (entity) DO UPDATE SET shape = EXCLUDED.shape, synced_at = now()`,
      [entityName, JSON.stringify(schema)],
    );
  }

  /**
   * Columns whose name changed while their property key stayed the same.
   *
   * Only that: a property key that also changed makes the two genuinely
   * indistinguishable from a drop and an add, and guessing there would lose
   * data silently in the cases it got wrong.
   *
   * Each rename is checked against the live database before it is used — the
   * old column has to be there and the new one absent. A snapshot can be stale
   * (someone altered the table by hand, an earlier sync failed part way), and
   * without that guard a stale one would rename the wrong column or fail on a
   * column that no longer exists.
   */
  private renames(
    previous: SchemaOptions | null,
    schema: SchemaOptions,
    existingCols: Record<string, ColumnInfo>,
  ): { from: string; to: string }[] {
    if (!previous) return [];

    const out: { from: string; to: string }[] = [];

    for (const [key, opt] of Object.entries(schema.columns)) {
      const before = (previous.columns as Record<string, { name?: string }>)[key];

      if (!before) continue;

      const from = String(before.name ?? key);
      const to = String((opt as { name?: string }).name ?? key);

      if (from === to) continue;
      if (!existingCols[from] || existingCols[to]) continue;

      out.push({ from, to });
    }

    return out;
  }

  async syncSchema(entityName: string, schema: SchemaOptions) {
    const table = this.dialect.quote(entityName);
    const previous = await this.snapshot(entityName);

    if (!(await this.dialect.tableExists(this.connection, entityName))) {
      const columnsSql = Object.entries(schema.columns)
        .map(([, opt]) => this.columnDefinition(opt, true))
        .join(",\n  ");

      await this.connection.query(`CREATE TABLE ${table} (\n  ${columnsSql}\n)`);

      for (const idx of schema.indexes || []) {
        await this.connection.query(this.indexStatement(entityName, schema, idx));
      }

      for (const chk of schema.checks || []) {
        await this.connection.query(this.checkStatement(entityName, chk));
      }

      await this.saveSnapshot(entityName, schema);

      return;
    }

    const existingCols = Object.fromEntries(
      (await this.dialect.listColumns(this.connection, entityName)).map((c) => [c.name, c]),
    );

    /* Renames first, so what follows sees the columns under the names the
       entity now uses. Left to the reconciliation below, each one would be a
       drop and an add — the same two statements, and the data gone. */
    for (const { from, to } of this.renames(previous, schema, existingCols)) {
      currentLogger().warn(`[DB] Renaming ${entityName}.${from} → ${to}`);
      await this.connection.query(this.dialect.renameColumn(entityName, from, to));
      existingCols[to] = { ...existingCols[from], name: to };
      delete existingCols[from];
    }

    for (const [, opt] of Object.entries(schema.columns)) {
      const dbCol = opt.name as string;

      if (!existingCols[dbCol]) {
        await this.connection.query(
          `ALTER TABLE ${table} ADD COLUMN ${this.columnDefinition(opt, false)}`,
        );
        continue;
      }

      /* A primary key is not null by definition, and saying so again is an
         error on some engines. */
      if (opt.primaryKey) continue;

      const isNotNull = !existingCols[dbCol].nullable;
      if (Boolean(opt.notNull) !== isNotNull) {
        await this.connection.query(
          this.dialect.alterNullable(entityName, dbCol, opt.type as string, Boolean(opt.notNull)),
        );
      }

      /* The engine reports its own name for a type — `character varying` for
         VARCHAR, `timestamp with time zone` for TIMESTAMPTZ — so the two are
         compared by whether one contains the other's words rather than as
         strings. Getting that wrong rewrites every column on every boot. */
      if (this.typeDiffers(opt.type as string, existingCols[dbCol])) {
        currentLogger().warn(
          `[DB] ${entityName}.${dbCol}: ${existingCols[dbCol].type} → ${opt.type} — the column is rewritten.`,
        );
        await this.connection.query(
          this.dialect.alterType(entityName, dbCol, opt.type as string),
        );
      }
    }

    /* Columns the entity no longer declares. This is the half that makes sync
       a mirror rather than an accumulation — without it a removed field leaves
       its column behind for good, and the schema drifts from the code that is
       supposed to describe it.

       It also destroys whatever the column held, which is why this belongs in
       development and nowhere else. */
    const declared = new Set(
      Object.values(schema.columns).map((opt: any) => String(opt.name)),
    );

    for (const name of Object.keys(existingCols)) {
      if (declared.has(name)) continue;

      currentLogger().warn(`[DB] Dropping ${entityName}.${name} — the entity no longer declares it.`);
      await this.connection.query(this.dialect.dropColumn(entityName, name));
      delete existingCols[name];
    }

    const existingIndexes = await this.dialect.listIndexes(this.connection, entityName);

    for (const idx of schema.indexes || []) {
      const create = this.indexStatement(entityName, schema, idx);

      if (!existingIndexes[idx.name]) {
        await this.connection.query(create);
        continue;
      }

      const currentDef = existingIndexes[idx.name];
      const mappedCols = idx.columns.map((c: string) => schema.columns[c]?.name || c);
      const colsMatch = mappedCols.every((c: string) => currentDef.includes(c));
      const uniqueMatch = idx.unique ? currentDef.includes("UNIQUE") : !currentDef.includes("UNIQUE");

      if (!colsMatch || !uniqueMatch) {
        currentLogger().warn(`[DB] Recreating index ${idx.name} on ${entityName}.`);
        await this.connection.query(`DROP INDEX ${this.dialect.quote(idx.name)}`);
        await this.connection.query(create);
      }
    }

    /* Indexes the entity no longer declares. Only ones that exist in their own
       right: an index backing a primary key or a unique constraint belongs to
       that constraint and goes when it does. */
    const declaredIndexes = new Set((schema.indexes || []).map((i: any) => i.name));

    for (const name of await this.dialect.listOwnedIndexes(this.connection, entityName)) {
      if (declaredIndexes.has(name)) continue;

      currentLogger().warn(`[DB] Dropping index ${name} on ${entityName} — no longer declared.`);
      await this.connection.query(`DROP INDEX ${this.dialect.quote(name)}`);
    }

    const existingChecks = await this.dialect.listChecks(this.connection, entityName);

    for (const chk of schema.checks || []) {
      if (!existingChecks[chk.name]) {
        await this.connection.query(this.checkStatement(entityName, chk));
        continue;
      }

      /* The server rewrites a check expression, so it is compared by the
         identifiers it mentions rather than character by character. */
      const tokens = chk.expression.match(/[a-zA-Z0-9_]{2,}/g) || [];
      if (!tokens.every((t: string) => existingChecks[chk.name].includes(t))) {
        currentLogger().warn(`[DB] Recreating check constraint ${chk.name} on ${entityName}.`);

        /* Added under a temporary name first, then swapped. Dropping first
           leaves a window with no constraint at all, and if the new one is
           refused the window never closes: the table ends up less protected
           than before the sync, with nothing to say so. Here a refusal happens
           before anything is dropped. */
        const staging = `${chk.name}_ecosy_new`;

        try {
          await this.connection.query(this.checkStatement(entityName, { ...chk, name: staging }));
        } catch (error) {
          /* The rows already there do not satisfy it. That is not a reason to
             refuse the change or to stop the application from starting: the
             schema has moved on, and what the constraint is for is everything
             written from now on.

             So it goes on unvalidated. New and updated rows are checked; the
             old ones stay as they are, and are named here because a constraint
             that does not describe the whole table is worth knowing about. */
          if (!this.dialect.supportsUnvalidatedCheck) throw error;

          await this.connection.query(
            this.checkStatement(entityName, { ...chk, name: staging }, false),
          );

          currentLogger().warn(
            `[DB] ${entityName}.${chk.name} added NOT VALID: existing rows do not all ` +
              `satisfy ${chk.expression}. New writes are checked; migrate the old rows ` +
              `and run VALIDATE CONSTRAINT to finish.`,
          );
        }

        await this.connection.query(
          `ALTER TABLE ${table} DROP CONSTRAINT ${this.dialect.quote(chk.name)}`,
        );
        await this.connection.query(
          `ALTER TABLE ${table} RENAME CONSTRAINT ${this.dialect.quote(staging)} ` +
            `TO ${this.dialect.quote(chk.name)}`,
        );
      }
    }

    /* Checks the entity no longer declares. */
    const declaredChecks = new Set((schema.checks || []).map((c: any) => c.name));

    for (const name of Object.keys(existingChecks)) {
      if (declaredChecks.has(name)) continue;

      currentLogger().warn(`[DB] Dropping check ${name} on ${entityName} — no longer declared.`);
      await this.connection.query(
        `ALTER TABLE ${table} DROP CONSTRAINT ${this.dialect.quote(name)}`,
      );
    }

    /* Last, so a sync that threw part way leaves the previous shape in place
       and the next run sees the same difference rather than a half-applied one. */
    await this.saveSnapshot(entityName, schema);
  }

  /**
   * Whether a declared type and the engine's reported type are different things.
   *
   * Engines rename types on the way in: TIMESTAMPTZ comes back as "timestamp
   * with time zone", VARCHAR(120) as "character varying", SERIAL as "integer".
   * A string comparison calls every one of those a change and rewrites the
   * whole table on every boot, so the test is whether the declared type's first
   * word appears in what the engine reported.
   */
  private typeDiffers(declared: string, column: ColumnInfo) {
    const want = declared.toLowerCase().replace(/\(.*/, "").trim();
    const have = column.type.toLowerCase();

    /* The size, when the declaration carries one. `character varying` says
       nothing about whether the column is 120 wide or 255, so a VARCHAR that
       changed length reads as unchanged without this and quietly keeps the old
       limit — the one case where "sync applies every change" would not. */
    const sized = declared.match(/\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/);

    if (sized) {
      const [, first, second] = sized;

      if (second === undefined) {
        if (column.length !== null && column.length !== Number(first)) return true;
        if (column.precision !== null && column.precision !== Number(first)) return true;
      } else {
        if (column.precision !== Number(first) || column.scale !== Number(second)) return true;
      }
    }

    const ALIASES: Record<string, string[]> = {
      timestamptz: ["timestamp with time zone"],
      timestamp: ["timestamp without time zone"],
      varchar: ["character varying"],
      char: ["character"],
      serial: ["integer"],
      bigserial: ["bigint"],
      bool: ["boolean"],
      int: ["integer"],
      int4: ["integer"],
      int8: ["bigint"],
      float8: ["double precision"],
      jsonb: ["jsonb"],
      uuid: ["uuid"],
      text: ["text"],
    };

    if (have.includes(want)) return false;

    return !(ALIASES[want] ?? []).some((alias) => have.includes(alias));
  }
}
