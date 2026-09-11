/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import { currentLogger } from "./logger";
import type { FindOptions, FindWhereOptions, ObjectWhere, SchemaOptions } from "./repository";
import type { Entity as BaseEntity } from "./entity";
import type { ColumnInfo, Dialect, Queryable, SyncOptions } from "./drivers/types";
import { currentDialect, currentDriver } from "./drivers/current";
import { DataSource } from "./data-source";
import { Transaction } from "./transaction";
import { withLock } from "./lock";
import { isSyncing, withinFrame } from "./sync-context";


/** Which rows an operation reaches on a soft-deleting entity. */
export type Scope = "live" | "deleted" | "all";

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

  /** Whether this engine can hand back the rows a write touched. */
  get canReturn(): boolean {
    return this.dialect.supportsReturning;
  }

  /**
   * Which rows an operation may touch, for an entity with `softDelete`.
   *
   * One rule for every operation: live rows, unless `withDeleted` or
   * `onlyDeleted` says otherwise out loud. And a WHERE that names the
   * soft-delete column while the scope is still "live" is refused rather than
   * run. It can only ever match nothing — `deleted_at BETWEEN …` ANDed with
   * `deleted_at IS NULL` — and a purge that silently deletes nothing is a
   * purge nobody notices is not running.
   */
  resolveScope(
    where: FindWhereOptions<Entity> | undefined,
    options: { withDeleted?: boolean | undefined; onlyDeleted?: boolean | undefined } = {},
  ): Scope {
    const key = this.schema.softDelete;

    if (options.withDeleted && options.onlyDeleted) {
      throw new Error(`[QueryBuilder] ${this.entityName}: withDeleted and onlyDeleted together mean nothing. Pick one.`);
    }
    if (!key) {
      if (options.withDeleted || options.onlyDeleted) {
        throw new Error(`[QueryBuilder] ${this.entityName} has no softDelete column, so there are no deleted rows to include.`);
      }
      return "all";
    }

    const scope: Scope = options.onlyDeleted ? "deleted" : options.withDeleted ? "all" : "live";
    if (scope === "live" && where && this.mentions(where, key)) {
      throw new Error(
        `[QueryBuilder] ${this.entityName}: the condition names "${key}", but only live rows are ` +
          `in scope — on those it is always NULL, so this would match nothing. Pass ` +
          `onlyDeleted: true (or withDeleted: true) to reach soft-deleted rows.`,
      );
    }
    return scope;
  }

  private mentions(where: FindWhereOptions<Entity>, key: string): boolean {
    if (Array.isArray(where)) return where.some((w) => this.mentions(w, key));
    const w = where as any;
    if (w && (w.type === "AND" || w.type === "OR") && Array.isArray(w.conditions)) {
      return w.conditions.some((c: FindWhereOptions<Entity>) => this.mentions(c, key));
    }
    return Boolean(w) && typeof w === "object" && key in w && w[key] !== undefined;
  }

  /**
   * The WHERE body for a condition plus a scope. The condition is wrapped: an
   * array condition builds an OR, and `a OR b AND deleted_at IS NULL` binds as
   * `a OR (b AND …)` — a deleted row matching `a` walks straight through.
   */
  /** Column sets of every live-only unique: column-level and index-level. */
  private liveUniques(): string[][] {
    const out: string[][] = [];
    for (const [key, opt] of Object.entries(this.schema.columns)) {
      if (opt.unique === "live") out.push([key]);
    }
    for (const idx of this.schema.indexes ?? []) {
      if (idx.unique === "live") out.push([...idx.columns]);
    }
    return out;
  }

  private scoped(where: FindWhereOptions<Entity> | undefined, params: any[], scope: Scope): string {
    const condition = this.buildWhereSql(where ?? ({} as any), params);
    const key = this.schema.softDelete;
    const filter = !key || scope === "all"
      ? ""
      : `${this.withEntity(key)} IS ${scope === "live" ? "" : "NOT "}NULL`;
    if (condition && filter) return `(${condition}) AND ${filter}`;
    return condition || filter;
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
    const where = this.scoped(options.where, params, this.resolveScope(options.where, options));
    
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

  /**
   * The columns a batch writes: every key some row gives a value, in first-seen
   * order.
   *
   * The UNION of every row's keys, not the first row's. Taking row 0 dropped a
   * field that only later rows carried, and turned a field missing from a later
   * row into NULL — which surfaced as a not-null violation naming the column
   * rather than the real cause, a row whose shape differed.
   *
   * A key whose value is `undefined` does not count as given. `pg` sends
   * `undefined` as NULL, so counting it wrote NULL over the column's DEFAULT on
   * insert and over the stored value on update — the second one erasing data
   * with no error, from code that only meant "I have nothing for this".
   */
  private givenKeys(arr: PartialInput<Entity>[]): string[] {
    return this.known([
      ...new Set(
        arr.flatMap((row) =>
          Object.entries(row).filter(([, v]) => v !== undefined).map(([k]) => k),
        ),
      ),
    ]);
  }

  buildInsert(arr: PartialInput<Entity>[]): { sql: string, params: any[] } {
    if (!arr.length) return { sql: "", params: [] };
    const tsKeys = this.givenKeys(arr);

    /* Nothing given at all: every column takes its default. `() VALUES ()` is
       not SQL, and one statement per row keeps the batch a batch. */
    if (!tsKeys.length) {
      if (arr.length === 1) {
        return { sql: `INSERT INTO ${this.entityName} DEFAULT VALUES` + this.returning(), params: [] };
      }
      throw new Error(
        `[QueryBuilder] insert() on "${this.entityName}" got ${arr.length} rows with no values ` +
          `in any of them. Insert them one at a time, or give at least one column a value.`,
      );
    }

    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        const value = (obj as any)[c];
        /* This row has nothing for a column another row fills. DEFAULT, not
           NULL: the row said nothing, so the schema decides. */
        if (value === undefined) return "DEFAULT";
        params.push(this.encode(c, value));
        return `${this.dialect.placeholder(params.length)}`;
      }).join(", ")})`;
    }).join(", ");
    
    const columns = tsKeys.map(c => this.q(this.dbCol(c))).join(", ");
    const sql = `INSERT INTO ${this.entityName} (${columns}) VALUES ${values}` + this.returning();

    return { sql, params };
  }

  buildUpdate(
    where: FindWhereOptions<Entity>,
    data: PartialInput<Entity>,
    returning = false,
    scope: Scope = "live",
  ): { sql: string, params: any[] } {
    const params: any[] = [];
    const given = Object.entries(data).filter(
      ([tsKey, v]) => tsKey in this.schema.columns && v !== undefined,
    );

    /* Nothing to write. An empty SET is a syntax error, and the honest answer
       to "update nothing" is no statement — the repository reports zero rows. */
    if (!given.length) return { sql: "", params: [] };

    const assignments = given
      .map(([tsKey, v]) => {
        params.push(this.encode(tsKey, v));
        return `${this.q(this.dbCol(tsKey))} = ${this.dialect.placeholder(params.length)}`;
      }).join(", ");
    const condition = this.scoped(where, params, scope);
    
    const sql = [
      `UPDATE ${this.entityName} SET ${assignments}`,
      condition ? `WHERE ${condition}` : "",
    ].filter(Boolean).join(" ") + (returning ? this.returning() : "");

    return { sql, params };
  }

  /**
   * Soft delete: stamps the column on live rows.
   *
   * The stamp is the transaction's start time, truncated to milliseconds, and
   * both halves are load-bearing. Transaction start: a parent and the children
   * its afterRemove soft-deletes share one value, which is what lets a restore
   * bring back exactly the children that went with it and not one deleted the
   * day before. Milliseconds: the driver hands timestamps to JavaScript as a
   * Date, which holds milliseconds; a microsecond stamp read back and passed
   * to `restore({ deletedAt })` would never equal itself.
   */
  buildSoftDelete(where: FindWhereOptions<Entity>, returning = false): { sql: string, params: any[] } {
    const key = this.schema.softDelete!;
    const params: any[] = [];
    const condition = this.scoped(where, params, "live");
    const stamp = this.dialect.softDeleteStamp ?? "CURRENT_TIMESTAMP";
    const sql = `UPDATE ${this.entityName} SET ${this.q(this.dbCol(key))} = ${stamp}` +
      (condition ? ` WHERE ${condition}` : "") + (returning ? this.returning() : "");
    return { sql, params };
  }

  /** Restore: clears the column on soft-deleted rows. */
  buildRestore(where: FindWhereOptions<Entity>, returning = false): { sql: string, params: any[] } {
    const key = this.schema.softDelete!;
    const params: any[] = [];
    const condition = this.scoped(where, params, "deleted");
    const sql = `UPDATE ${this.entityName} SET ${this.q(this.dbCol(key))} = NULL` +
      (condition ? ` WHERE ${condition}` : "") + (returning ? this.returning() : "");
    return { sql, params };
  }

  buildDelete(where: FindWhereOptions<Entity>, returning = false, scope: Scope = "live"): { sql: string, params: any[] } {
    const params: any[] = [];
    const condition = this.scoped(where, params, scope);
    
    const sql = [
      `DELETE FROM ${this.entityName}`,
      condition ? `WHERE ${condition}` : "",
    ].filter(Boolean).join(" ") + (returning ? this.returning() : "");

    return { sql, params };
  }

  /**
   * `skipsDeleted` is true when a conflict with a soft-deleted row leaves that
   * row alone rather than updating it — see `Repository.upsert`.
   */
  buildUpsert(arr: PartialInput<Entity>[], conflictColumns: string[]): { sql: string, params: any[], skipsDeleted: boolean } {
    if (!arr.length) return { sql: "", params: [], skipsDeleted: false };
    const tsKeys = this.givenKeys(arr);

    /* An insert can fill a gap with DEFAULT; an upsert cannot. On conflict the
       row is updated from EXCLUDED, and EXCLUDED of a DEFAULT cell is the
       default — so a row that only lacked a value would overwrite the stored
       one with it. Refused instead of doing that quietly. */
    for (const c of tsKeys) {
      const missing = arr.filter((row) => (row as any)[c] === undefined).length;
      if (missing) {
        throw new Error(
          `[QueryBuilder] upsert() on "${this.entityName}": ${missing} of ${arr.length} rows ` +
            `have no value for "${c}" while others do. On conflict that row would overwrite ` +
            `the stored "${c}" with its default. Give every row the same fields, or split the batch.`,
        );
      }
    }

    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        params.push(this.encode(c, (obj as any)[c]));
        return `${this.dialect.placeholder(params.length)}`;
      }).join(", ")})`;
    }).join(", ");
    
    const columns = tsKeys.map(c => this.q(this.dbCol(c))).join(", ");
    const insertSql = `INSERT INTO ${this.entityName} (${columns}) VALUES ${values}`;

    /* Without a conflict target Postgres cannot infer an arbiter index, and the
       clause degenerates to `ON CONFLICT ()` — another syntax error built one
       string concatenation at a time. An upsert with nothing to conflict on is
       an insert, and saying so is more useful than emitting SQL that cannot
       parse. */
    if (!conflictColumns.length) {
      throw new Error(
        `[QueryBuilder] upsert() on "${this.entityName}" was given no conflict ` +
          `columns. Name the columns whose unique index decides a collision, or ` +
          `call insert() if there is nothing to collide with.`,
      );
    }

    const dbConflictColumns = conflictColumns.map(c => this.dbCol(c));

    const updateColumns = tsKeys
      .filter(c => !conflictColumns.includes(c))
      .map(c => this.dbCol(c));

    /* A conflict target that is a live-only unique index has to be named with
       its predicate, or Postgres finds no arbiter index to match it against. */
    const live = this.liveUniques().find(
      (cols) => cols.length === conflictColumns.length && cols.every((c) => conflictColumns.includes(c)),
    );
    const predicate = live
      ? `${this.q(this.dbCol(this.schema.softDelete!))} IS NULL`
      : undefined;

    /* A full unique counts soft-deleted rows, so the conflict can land on one.
       Updating it would revive it without restore(), carrying every column the
       payload did not mention back from the deleted row. The update is fenced
       to live rows instead; a dead row that conflicts is left alone and
       returns nothing, and the repository refuses the batch. */
    const soft = this.schema.softDelete;
    const skipsDeleted = Boolean(soft) && !live;
    const updateWhere = skipsDeleted ? `${this.withEntity(soft!)} IS NULL` : undefined;

    const sql = `${insertSql} ${this.dialect.upsertClause(dbConflictColumns, updateColumns, predicate, updateWhere)}${this.returning()}`;
    
    return { sql, params, skipsDeleted };
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
  ) {
    this.base = this.connection;
    const real = this.connection;
    const isRead = (sql: string) => /^\s*(SELECT|WITH)\b/i.test(sql);
    const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

    if (this.sync.dryRun) {
      const planned = this.planned;
      /* Reads go through, so the plan is made against the database as it is;
         anything else is recorded and answered with nothing. */
      this.connection = {
        query: async (sql: string, params?: unknown[]) => {
          if (isRead(sql)) return real.query(sql, params);
          planned.push(flat(sql));
          currentLogger().info(`[DB] plan: ${planned[planned.length - 1]}`);
          return { rows: [], rowCount: 0 };
        },
      };
    } else {
      /* Every statement that changes the schema says so, as it runs. An
         automatic schema change that only a dry run would have shown — a
         DROP NOT NULL on a kept column, found by reading information_schema —
         is one nobody can audit afterwards. The snapshot bookkeeping is the one
         write left out: it happens on every sync and changes nothing. */
      this.connection = {
        query: async (sql: string, params?: unknown[]) => {
          const result = await real.query(sql, params);
          if (!isRead(sql) && !sql.includes(SchemaBuilder.SNAPSHOT_TABLE)) {
            currentLogger().info(`[DB] ran: ${flat(sql)}`);
          }
          return result;
        },
      };
    }
  }

  /** The connection as given, before the plan/announce wrapper. */
  private readonly base: Queryable;

  /**
   * Narration of something sync is doing — "Setting the default of …". Not in
   * a dry run: the `plan:` line already says what would happen, and a line in
   * the present tense above it reads as if it had.
   */
  private act(level: "info" | "warn", message: string) {
    if (this.sync.dryRun) return;
    currentLogger()[level](message);
  }

  /** With `dryRun`: every statement sync would have sent, in order. */
  readonly planned: string[] = [];

  /** What sync kept, per entity, because the mode does not let it remove. */
  private leftovers = new Map<string, string[]>();

  private get removes(): boolean {
    return this.sync.mode === "mirror";
  }

  private keep(entityName: string, what: string) {
    const list = this.leftovers.get(entityName) ?? [];
    list.push(what);
    this.leftovers.set(entityName, list);
  }

  private columnDefinition(opt: any, withPrimaryKey: boolean, withNotNull = true) {
    let def = `${this.dialect.quote(opt.name)} ${opt.type}`;
    if (withPrimaryKey && opt.primaryKey) def += " PRIMARY KEY";
    /* `"live"` is a partial index, built with the other indexes. */
    if (opt.unique === true) def += " UNIQUE";
    if (opt.notNull && withNotNull) def += " NOT NULL";
    if (opt.default) def += ` DEFAULT ${opt.default}`;
    if (opt.references) def += ` REFERENCES ${opt.references}`;
    return def;
  }

  /**
   * Whether an existing foreign key already says what the entity declares.
   *
   * Both sides are normalised because the two spellings never match literally:
   * the engine schema-qualifies the target, quotes identifiers, and omits the
   * clauses that are already the default. An entity that spells a default out
   * — `ON DELETE NO ACTION` — means the same thing as an entity that leaves it
   * off, and comparing them raw would put the constraint back into the
   * drop-and-recreate loop this exists to end.
   */
  private normaliseConstraint(text: string) {
    return text
      .toUpperCase()
      .replace(/"/g, "")
      .replace(/\bPUBLIC\./g, "")
      .replace(/\s+ON\s+DELETE\s+NO\s+ACTION\b/g, "")
      .replace(/\s+ON\s+UPDATE\s+NO\s+ACTION\b/g, "")
      .replace(/\s+MATCH\s+SIMPLE\b/g, "")
      .replace(/\s+/g, " ")
      .replace(/\s*\(\s*/g, "(")
      .replace(/\s*\)\s*/g, ")")
      .trim();
  }

  private indexStatement(entityName: string, schema: SchemaOptions, idx: any) {
    const unique = idx.unique ? "UNIQUE " : "";
    const cols = idx.columns
      .map((c: string) => this.dialect.quote(schema.columns[c]?.name || c))
      .join(", ");
    const where = idx.unique === "live" ? ` WHERE ${this.livePredicate(schema)}` : "";
    return `CREATE ${unique}INDEX ${this.dialect.quote(idx.name)} ON ${this.dialect.quote(entityName)} (${cols})${where}`;
  }

  private livePredicate(schema: SchemaOptions) {
    const col = schema.columns[schema.softDelete!];
    return `${this.dialect.quote(String(col?.name ?? schema.softDelete))} IS NULL`;
  }

  /**
   * The declared indexes plus one per column declared `unique: "live"`.
   *
   * A column-level live unique is a partial index, so it has to be counted as
   * declared — otherwise the pass that drops undeclared indexes would remove it
   * on the next boot, and the column would quietly stop being unique at all.
   */
  private effectiveIndexes(entityName: string, schema: SchemaOptions): any[] {
    const synthesized = Object.entries(schema.columns)
      .filter(([, opt]) => opt.unique === "live")
      .map(([key, opt]) => ({ name: `${entityName}_${opt.name ?? key}_live_key`, columns: [key], unique: "live" }));
    return [...(schema.indexes ?? []), ...synthesized];
  }

  /**
   * Refuses, by name and example, to build a unique index over data that
   * already breaks it. Left to the engine it is "could not create unique
   * index", once, for the first pair it trips on.
   */
  private async assertUnique(entityName: string, schema: SchemaOptions, keys: readonly string[], live: boolean) {
    if (this.sync.dryRun) return;
    const cols = keys.map((k) => this.dialect.quote(String(schema.columns[k]?.name ?? k)));
    const filters = cols.map((c) => `${c} IS NOT NULL`);
    if (live) filters.push(this.livePredicate(schema));
    const dupes = await this.connection.query(
      `SELECT ${cols.join(", ")}, count(*) AS n FROM ${this.dialect.quote(entityName)} ` +
        `WHERE ${filters.join(" AND ")} GROUP BY ${cols.join(", ")} HAVING count(*) > 1 LIMIT 3`,
    );
    if (dupes.rows.length) {
      const sample = dupes.rows.map((r: any) => keys.map((k) => JSON.stringify(r[String(schema.columns[k]?.name ?? k)])).join("/")).join(", ");
      throw new Error(
        `[DB] ${entityName} (${keys.join(", ")}) is declared unique${live ? ' among live rows' : ""}, but ` +
          `existing rows repeat values — for example ${sample}. Resolve them from an effect, which ` +
          `runs before unique constraints are applied.`,
      );
    }
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

    let result;
    try {
      result = await this.connection.query(
        `SELECT shape FROM ${this.dialect.quote(SchemaBuilder.SNAPSHOT_TABLE)} WHERE entity = $1`,
        [entityName],
      );
    } catch (error: any) {
      /* A plan recorded the CREATE TABLE rather than running it. */
      if (this.sync.dryRun && error?.code === "42P01") return null;
      throw error;
    }

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

  /**
   * Brings the defaults of existing columns in line with the entity.
   *
   * Compared by rendering, not by text. Postgres rewrites a default when it
   * stores it — `'html'` comes back `'html'::text` — so a textual comparison
   * would set every such default again on every boot. Declarations that
   * already match textually cost nothing; the rest are rendered by the engine
   * in one go and compared rendering to rendering.
   *
   * Serial columns are left alone either way: their default is the sequence,
   * which the entity states through the type, not through `default`.
   */
  private async reconcileDefaults(
    entityName: string,
    columns: { dbCol: string; opt: any; current: string | null }[],
  ) {
    if (!this.dialect.alterDefault) return;

    const serial = (opt: any) => /SERIAL$/i.test(String(opt.type).trim());
    const toSet: { dbCol: string; expression: string }[] = [];
    const toCompare: { dbCol: string; opt: any; current: string; declared: string }[] = [];

    for (const { dbCol, opt, current } of columns) {
      if (serial(opt)) continue;
      const declared = opt.default === undefined || opt.default === null ? null : String(opt.default).trim();

      if (declared === null) {
        if (current === null || /^nextval\(/i.test(current)) continue;
        if (!this.removes) {
          this.keep(entityName, `default of ${dbCol}`);
          continue;
        }
        this.act("warn", `[DB] Dropping the default of ${entityName}.${dbCol} — the entity no longer declares one.`);
        await this.connection.query(this.dialect.alterDefault(entityName, dbCol, null));
        continue;
      }

      if (current === null) toSet.push({ dbCol, expression: declared });
      else if (current !== declared && !sameLiteral(current, declared)) {
        toCompare.push({ dbCol, opt, current, declared });
      }
    }

    if (toCompare.length && this.dialect.renderDefaults) {
      const render = this.dialect.renderDefaults.bind(this.dialect);
      const defs = toCompare.map((c) => ({ type: String(c.opt.type), expression: c.declared }));
      let rendered: string[] | null = null;

      try {
        /* The probe needs one session for its temporary table. A transaction
           is one, so the builder's own connection is used when it is one; the
           pool is not, so a transaction is borrowed from it otherwise. */
        rendered = this.base instanceof Transaction
          ? await render(this.base, defs)
          : await DataSource.transaction((tx) => render(tx, defs));
      } catch (error: any) {
        /* 42501: no TEMP privilege. Refusing to boot over a comparison is out
           of proportion — the defaults are left as they are, and said so. */
        if (error?.code !== "42501") throw error;
        currentLogger().warn(
          `[DB] Cannot compare the defaults of ${entityName} (${toCompare.map((c) => c.dbCol).join(", ")}): ` +
            `the database refuses temporary tables to this role. They are left as they are.`,
        );
      }

      rendered?.forEach((text, i) => {
        if (text !== toCompare[i]!.current) toSet.push({ dbCol: toCompare[i]!.dbCol, expression: toCompare[i]!.declared });
      });
    }

    for (const { dbCol, expression } of toSet) {
      this.act("info", `[DB] Setting the default of ${entityName}.${dbCol} to ${expression}.`);
      await this.connection.query(this.dialect.alterDefault(entityName, dbCol, expression));
    }
  }

  /**
   * `UPDATE … SET col = DEFAULT WHERE col IS NULL`, retried on a unique
   * collision.
   *
   * The default is evaluated per row, so a random one gives every row its
   * own value — and on a unique column two of them can still meet, or meet a
   * value already stored. The statement is atomic, so a collision leaves
   * nothing half-written and running it again draws fresh values. Five
   * attempts: at the sizes a boot-time fill runs at, a random default that
   * collides five times running is not a random default.
   */
  private async fillFromDefault(entityName: string, dbCol: string, unique: boolean) {
    const sql =
      `UPDATE ${this.dialect.quote(entityName)} SET ${this.dialect.quote(dbCol)} = DEFAULT ` +
      `WHERE ${this.dialect.quote(dbCol)} IS NULL`;
    const attempts = unique ? 5 : 1;

    for (let attempt = 1; ; attempt++) {
      try {
        await this.connection.query(sql);
        return;
      } catch (error: any) {
        /* 23514: filling one column rewrites the whole row, and the row is
           checked whole — so a check left NOT VALID over the very rows being
           filled refuses the fill for a column it never mentions. sniprender
           has exactly that: projects_type_known NOT VALID over 'web' rows. */
        if (error?.code === "23514") {
          throw new Error(
            `[DB] Filling ${entityName}.${dbCol} from its default was refused by check ` +
              `"${error.constraint ?? "?"}": rows that need filling break it — it was left NOT VALID ` +
              `over them. Fix those rows first, from an effect on the entity: effects run before ` +
              `this fill.`,
            { cause: error },
          );
        }
        if (error?.code !== "23505" || attempt >= attempts) {
          if (error?.code === "23505") {
            throw new Error(
              `[DB] Filling ${entityName}.${dbCol} from its default hit a duplicate ${attempts} times ` +
                `running — against a stored row, or between two values drawn in the same fill. ` +
                `Its default cannot produce enough distinct values for a unique column: widen it, ` +
                `or fill these rows from an effect.`,
              { cause: error },
            );
          }
          throw error;
        }
        this.act("warn", `[DB] ${entityName}.${dbCol}: default collided on a unique value, retrying (${attempt}/${attempts}).`);
      }
    }
  }

  /**
   * Says so when the database itself will change this entity's rows behind
   * its hooks.
   *
   * `ON DELETE CASCADE` deletes rows of this table when a referenced row goes,
   * and Postgres does it — the ORM never issues a statement, so beforeRemove
   * and afterRemove never run. `SET NULL`, `SET DEFAULT` and `ON UPDATE
   * CASCADE` do the same to the update hooks. Nothing here can stop that; what
   * sync can do is read the foreign keys the entity declares and say it out
   * loud when a hook it also declares is about to be bypassed.
   *
   * Only for keys declared in `references`. A cascade created by hand in SQL
   * is invisible from here, and so is a row changed by hand-written SQL.
   */
  private warnHookBypass(entityName: string, schema: SchemaOptions, EntityClass: unknown) {
    const proto = (EntityClass as { prototype?: Record<string, unknown> } | undefined)?.prototype;
    if (!proto) return;
    const declares = (...hooks: string[]) => hooks.filter((h) => typeof proto[h] === "function");

    const removeHooks = declares("beforeRemove", "afterRemove");
    const updateHooks = declares("beforeUpdate", "afterUpdate");
    if (!removeHooks.length && !updateHooks.length) return;

    for (const opt of Object.values(schema.columns) as any[]) {
      const ref = String(opt.references ?? "");
      if (!ref || opt.acknowledgeHookBypass) continue;

      if (removeHooks.length && /ON\s+DELETE\s+CASCADE/i.test(ref)) {
        currentLogger().warn(
          `[DB] ${entityName} declares ${removeHooks.join(" and ")}, but ${entityName}.${opt.name} ` +
            `references ${ref}: rows removed by that cascade are deleted by the database, and no ` +
            `hook sees them. If that is intended, say so with acknowledgeHookBypass: true on the column.`,
        );
      }
      if (updateHooks.length && /ON\s+(DELETE\s+SET\s+(NULL|DEFAULT)|UPDATE\s+(CASCADE|SET\s+(NULL|DEFAULT)))/i.test(ref)) {
        currentLogger().warn(
          `[DB] ${entityName} declares ${updateHooks.join(" and ")}, but ${entityName}.${opt.name} ` +
            `references ${ref}: rows that action changes are changed by the database, and no ` +
            `hook sees them. If that is intended, say so with acknowledgeHookBypass: true on the column.`,
        );
      }
    }
  }

  /**
   * Loosen-phase half of changing a check: the old one is replaced by one
   * that admits what either declaration admits, `(old) OR (new)`.
   *
   * Replacing a stored value — `'web'` becoming `'html'`, say — needs the new
   * value writable while the old one is still in the rows, which is exactly
   * when an effect runs. Left in place, the old check refuses the effect's
   * UPDATE whenever the new value is not on the old list. Dropped outright,
   * the table is unguarded, and stays so if the effect then fails. The union
   * is the DBA's widen → migrate → narrow, done by sync: the tighten phase
   * puts the new declaration on and removes the stand-in.
   */
  private async widenChangedChecks(entityName: string, schema: SchemaOptions) {
    if (!schema.checks?.length || !this.dialect.describeCheck || !this.dialect.supportsUnvalidatedCheck) return;
    const existing = await this.dialect.listChecks(this.connection, entityName);
    const table = this.dialect.quote(entityName);

    for (const chk of schema.checks) {
      const current = existing[chk.name];
      if (!current || current.declared === null || current.declared.trim() === chk.expression.trim()) continue;

      const wide = `${chk.name}_ecosy_wide`;
      this.act("info", `[DB] Check ${chk.name} on ${entityName} changed — admitting old and new values while effects run.`);
      /* Not under a lock: two processes booting on the same change both get
         here. Every step therefore tolerates the other having done it first —
         IF EXISTS on the drops, 42710 (already exists) on the add. */
      if (existing[wide]) await this.connection.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${this.dialect.quote(wide)}`);
      /* NOT VALID: the stand-in lives for the length of one sync, and the rows
         already satisfy the old half — there is nothing to scan for. */
      try {
        await this.connection.query(this.checkStatement(
          entityName,
          { name: wide, expression: `(${current.declared}) OR (${chk.expression})` },
          false,
        ));
      } catch (error: any) {
        if (error?.code !== "42710") throw error;
      }
      await this.connection.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${this.dialect.quote(chk.name)}`);
    }
  }

  /** Adds a check; over rows that break it, adds it NOT VALID and says what that costs. */
  private async addCheck(entityName: string, chk: { name: string; expression: string }) {
    try {
      await this.connection.query(this.checkStatement(entityName, chk));
    } catch (error: any) {
      /* Another process booting alongside added it between our read and now. */
      if (error?.code === "42710") return;
      if (error?.code !== "23514" || !this.dialect.supportsUnvalidatedCheck) throw error;
      await this.connection.query(this.checkStatement(entityName, chk, false));
      await this.explainUnvalidated(entityName, chk);
    }
  }

  private async validateOrExplain(entityName: string, chk: { name: string; expression: string }) {
    if (!this.dialect.validateCheck) return;
    try {
      await this.connection.query(this.dialect.validateCheck(entityName, chk.name));
      this.act("info", `[DB] Check ${chk.name} on ${entityName} validated — every row satisfies it now.`);
    } catch (error: any) {
      if (error?.code !== "23514") throw error;
      await this.explainUnvalidated(entityName, chk);
    }
  }

  /**
   * The warning for a check left NOT VALID, which used to say "new writes are
   * checked" — true, and misleading enough to take sniprender down: NOT VALID
   * checks every UPDATE too, so each of the old rows fails the moment anything
   * writes to it. It says that now, with the count.
   */
  private async explainUnvalidated(entityName: string, chk: { name: string; expression: string }) {
    if (this.sync.dryRun) return;
    const bad = await this.connection.query(
      `SELECT count(*) AS n FROM ${this.dialect.quote(entityName)} WHERE NOT (${chk.expression})`,
    );
    const n = Number(bad.rows[0]?.n ?? 0);
    currentLogger().warn(
      `[DB] Check ${chk.name} on ${entityName} is NOT VALID: ${n} existing row${n === 1 ? "" : "s"} ` +
        `do${n === 1 ? "es" : ""} not satisfy ${chk.expression}. Postgres checks every write against ` +
        `it — including any UPDATE to one of those rows, which fails with 23514 until the row is ` +
        `fixed. Replace the values from an effect on the entity; sync validates the check once ` +
        `every row satisfies it.`,
    );
  }

  /**
   * Brings one table in line with its entity.
   *
   * On an existing table the work runs in three phases, and the order is the
   * point: first everything that only loosens or adds — renames, new columns,
   * retypes, `DROP NOT NULL`; then the entity's effects; then everything that
   * tightens or removes — `SET NOT NULL`, dropped columns, foreign keys,
   * checks. A constraint the existing rows do not yet satisfy is the reason a
   * boot fails, and the middle phase is the one place data can be brought up
   * to it: the column exists, and nothing refuses the table yet.
   *
   * @param EntityClass The entity, when there is one, for its `effects`.
   */
  async syncSchema(entityName: string, schema: SchemaOptions, EntityClass?: unknown) {
    const hasEffects = Boolean((EntityClass as { effects?: unknown[] } | undefined)?.effects?.length);
    const lockable = Boolean(this.dialect.advisoryLock && this.dialect.advisoryUnlock);

    /* Held at once while an effect runs: sync's lock, the effects' lock, the
       effect's transaction. Without effects: the lock, and a transaction for
       the default probe beside it. A pool smaller than that does not error —
       it waits for a connection only its own caller can free, forever. */
    const needed = hasEffects ? 3 : 2;
    const max = safeMaxConnections();
    if (lockable && max !== undefined && max < needed) {
      throw new Error(
        `[DB] Syncing ${entityName} holds up to ${needed} connections at once — a lock, ` +
          `${hasEffects ? "the effects' lock and an effect's transaction" : "and a transaction beside it"} — ` +
          `and the pool allows ${max}. It would wait on itself and never finish. Raise \`max\` to ${needed} or more.`,
      );
    }

    /* A sync that reaches its own entity again — an effect calling
       syncSchema(), typically — would wait for the lock the outer sync holds,
       which is released only when that effect returns. Caught by call chain,
       not by a process-wide set: concurrent syncs of one entity, which the
       lock serialises, are fine; only a sync nested inside itself is not. */
    if (await isSyncing(entityName)) {
      throw new Error(
        `[DB] syncSchema("${entityName}") was called from inside the sync of ${entityName} — from ` +
          `one of its effects, most likely. It would wait forever for the lock the outer sync ` +
          `holds. An effect already runs mid-sync; do the work in it directly.`,
      );
    }
    return withinFrame("sync", entityName, () => this.syncLocked(entityName, schema, EntityClass));
  }

  private syncLocked(entityName: string, schema: SchemaOptions, EntityClass?: unknown) {
    /* One process at a time per table. Several replicas booting together
       otherwise interleave statement by statement — one drops what another is
       about to drop, or reads a constraint between the ADD and the COMMENT that
       records its declaration, and takes the half-made state for an old one.
       Each such gap can be patched on its own; the lock closes all of them. */
    return withLock(`ecosy:orm:sync:${entityName}`, () => this.syncUnlocked(entityName, schema, EntityClass));
  }

  private async syncUnlocked(entityName: string, schema: SchemaOptions, EntityClass?: unknown) {
    const table = this.dialect.quote(entityName);
    const runEffects = async () => {
      const declared = (EntityClass as { effects?: { name: string }[] } | undefined)?.effects;
      if (!declared?.length) return;
      if (this.sync.dryRun) {
        this.planned.push(`-- effects of ${entityName} would run here: ${declared.map((e) => e.name).join(", ")}`);
        return;
      }
      /* Imported here, not at the top: effects need a repository, a
         repository needs this module, and a cycle in a package whose root
         re-exports both is a class that is undefined when the other loads. */
      const effects = await import("./effects");
      await effects.runEffects(EntityClass);
    };
    const previous = await this.snapshot(entityName);

    if (!(await this.dialect.tableExists(this.connection, entityName))) {
      const columnsSql = Object.entries(schema.columns)
        .map(([, opt]) => this.columnDefinition(opt, true))
        .join(",\n  ");

      await this.connection.query(`CREATE TABLE ${table} (\n  ${columnsSql}\n)`);

      for (const idx of this.effectiveIndexes(entityName, schema)) {
        await this.connection.query(this.indexStatement(entityName, schema, idx));
      }

      /* Declarations recorded here too, not only on the reconcile path. Without
         this a freshly created table pays one recreation of every check on its
         second boot — the self-heal firing for constraints that were never
         stale, which is the cost this whole mechanism exists to avoid. */
      for (const chk of schema.checks || []) {
        await this.connection.query(this.checkStatement(entityName, chk));
        if (this.dialect.describeCheck) {
          await this.connection.query(this.dialect.describeCheck(entityName, chk.name, chk.expression));
        }
      }

      await this.saveSnapshot(entityName, schema);

      /* A new table has no rows to bring up to anything, but a `"once"`
         effect still runs — and is recorded — here, so it does not wait for a
         later boot to find data it was never meant for. */
      await runEffects();
      this.warnHookBypass(entityName, schema, EntityClass);

      return;
    }

    const existingCols = Object.fromEntries(
      (await this.dialect.listColumns(this.connection, entityName)).map((c) => [c.name, c]),
    );

    /* Renames first, so what follows sees the columns under the names the
       entity now uses. Left to the reconciliation below, each one would be a
       drop and an add — the same two statements, and the data gone. */
    for (const { from, to } of this.renames(previous, schema, existingCols)) {
      this.act("warn", `[DB] Renaming ${entityName}.${from} → ${to}`);
      await this.connection.query(this.dialect.renameColumn(entityName, from, to));
      existingCols[to] = { ...existingCols[from], name: to };
      delete existingCols[from];
    }

    const added: string[] = [];
    /* Columns that must become NOT NULL once the effects have had their turn. */
    const tighten: { dbCol: string; opt: any }[] = [];
    /* Existing columns, for reconciling their defaults after the loop. */
    const defaults: { dbCol: string; opt: any; current: string | null }[] = [];

    for (const [, opt] of Object.entries(schema.columns)) {
      const dbCol = opt.name as string;

      if (!existingCols[dbCol]) {
        added.push(dbCol);
        /* With a DEFAULT the new column is filled as it is added, so NOT NULL
           can go on in the same statement. Without one, every existing row
           holds NULL — adding it NOT NULL there fails outright on any table
           with data, which is exactly the table an effect exists to fill. */
        const deferNotNull = Boolean(opt.notNull) && !opt.default;
        await this.connection.query(
          `ALTER TABLE ${table} ADD COLUMN ${this.columnDefinition(opt, false, !deferNotNull)}`,
        );
        if (deferNotNull) tighten.push({ dbCol, opt });
        continue;
      }

      defaults.push({ dbCol, opt, current: existingCols[dbCol].default ?? null });

      /* A primary key is not null by definition, and saying so again is an
         error on some engines. */
      if (opt.primaryKey) continue;

      const isNotNull = !existingCols[dbCol].nullable;
      if (!opt.notNull && isNotNull) {
        await this.connection.query(
          this.dialect.alterNullable(entityName, dbCol, opt.type as string, false),
        );
      } else if (opt.notNull && !isNotNull) {
        tighten.push({ dbCol, opt });
      }

      /* The engine reports its own name for a type — `character varying` for
         VARCHAR, `timestamp with time zone` for TIMESTAMPTZ — so the two are
         compared by whether one contains the other's words rather than as
         strings. Getting that wrong rewrites every column on every boot. */
      if (this.typeDiffers(opt.type as string, existingCols[dbCol])) {
        this.act("warn", 
          `[DB] ${entityName}.${dbCol}: ${existingCols[dbCol].type} → ${opt.type} — the column is rewritten.`,
        );
        await this.connection.query(
          this.dialect.alterType(entityName, dbCol, opt.type as string),
        );
      }
    }

    /* Still the loosening phase: a default refuses no row. Done before the
       effects so they, and the fill below, see the default the entity now
       declares rather than the one the table had. */
    await this.reconcileDefaults(entityName, defaults);
    await this.widenChangedChecks(entityName, schema);

    await runEffects();

    for (const { dbCol, opt } of tighten) {
      /* Counted first so the failure names what to do. Left to the engine it
         reads "column contains null values" and stops the boot — the error
         sniprender met when `projects.code` became required over rows that
         predated it. */
      const countNulls = async () => Number((await this.connection.query(
        `SELECT count(*) AS n FROM ${table} WHERE ${this.dialect.quote(dbCol)} IS NULL`,
      )).rows[0]?.n ?? 0);

      /* In a plan the column may not exist yet — its ADD was recorded, not
         run — and the effects that would fill it did not run either. */
      if (this.sync.dryRun) {
        await this.connection.query(this.dialect.alterNullable(entityName, dbCol, opt.type as string, true));
        continue;
      }

      let n = await countNulls();

      /* A declared default fills them, the way ADD COLUMN fills existing rows
         with one: the entity said what an absent value is, and a NULL row is
         a row with an absent value. */
      if (n > 0 && opt.default) {
        this.act("warn", 
          `[DB] Filling ${n} NULL row${n === 1 ? "" : "s"} of ${entityName}.${dbCol} from its ` +
            `default before applying NOT NULL.`,
        );
        await this.fillFromDefault(entityName, dbCol, Boolean(opt.unique));
        n = await countNulls();
      }

      if (n > 0) {
        throw new Error(
          `[DB] ${entityName}.${dbCol} is declared notNull, but ${n} existing ` +
            `row${n === 1 ? "" : "s"} hold${n === 1 ? "s" : ""} NULL` +
            (opt.default
              ? ` even after filling from its default, which evaluates to NULL for them.`
              : `. Declare a default on the column — sync fills NULL rows from it before applying ` +
                `NOT NULL — or fill them from an effect on the entity: \`static effects\` with ` +
                `when: "sync" or "once", which runs after the column exists and before this ` +
                `constraint is applied.`),
        );
      }
      await this.connection.query(
        this.dialect.alterNullable(entityName, dbCol, opt.type as string, true),
      );
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

      if (!this.removes) {
        const loosen = !existingCols[name]!.nullable;
        this.keep(entityName, `column ${name}${loosen ? ` (${this.sync.dryRun ? "would be made" : "made"} nullable)` : ""}`);
        /* Kept, but no longer allowed to refuse a row: inserts written against
           the entity do not mention it, and NOT NULL without a default would
           fail every one of them. */
        if (loosen) {
          await this.connection.query(this.dialect.alterNullable(entityName, name, existingCols[name]!.type, false));
        }
        continue;
      }

      /* One column gone and another arrived in the same sync is what a rename
         looks like from here. Telling them apart needs the snapshot, which is
         off unless a project asked for it — so without it this drop may be
         throwing away the data a rename was meant to carry across, and the log
         is the only place that can say so.

         Worth saying out loud because the feature that prevents it is
         documented as existing while being, for most projects, not switched
         on: reading that it exists is not the same as it running. */
      if (!this.sync.snapshot && added.length) {
        currentLogger().warn(
          `[DB] ${entityName}.${name} ${this.sync.dryRun ? "would be" : "is being"} dropped while ${added.join(", ")} ` +
            `${added.length === 1 ? "was" : "were"} added. If that is a rename, the data ` +
            `${this.sync.dryRun ? "would be" : "is about to be"} lost — sync cannot tell a rename from a drop-and-add without ` +
            `\`sync: { snapshot: true }\` on the driver, which is off by default.`,
        );
      }

      this.act("warn", `[DB] Dropping ${entityName}.${name} — the entity no longer declares it.`);
      await this.connection.query(this.dialect.dropColumn(entityName, name));
      delete existingCols[name];
    }

    /* Foreign keys.
     *
     * Until now a `references` only ever reached the database if the column
     * carrying it was BORN with it — inline in CREATE TABLE, or inline in ADD
     * COLUMN. Adding `references` to a column that already existed did
     * nothing, changing it did nothing, and removing it left the constraint in
     * place for good. Nothing said so; the schema simply stopped being a
     * description of the database.
     *
     * Scoped deliberately to columns the entity declares. A foreign key on a
     * column this entity knows nothing about is left alone — unlike the check
     * constraints below, which drop anything undeclared. The asymmetry is on
     * purpose: a check dropped by mistake stops rejecting bad rows, while a
     * foreign key dropped by mistake surrenders referential integrity, and the
     * damage is already done by the time anyone notices.
     */
    const existingKeys = await this.dialect.listForeignKeys(this.connection, entityName);

    for (const opt of Object.values(schema.columns) as any[]) {
      const column = String(opt.name);
      const current = existingKeys[column];
      const wanted = opt.references ? String(opt.references) : null;

      /* Compared as whole definitions, not as target names.
       *
       * The first version of this rebuilt `table(column)` from catalog columns
       * and compared that — which silently threw away `ON DELETE` and
       * `ON UPDATE`. Every constraint carrying one then looked different from
       * itself on every boot, so sync dropped and re-added it each time. Not
       * merely noisy: ADD CONSTRAINT ... FOREIGN KEY takes an ACCESS EXCLUSIVE
       * lock on both tables and re-validates every row, and between the drop
       * and the add there is a window with no constraint at all.
       *
       * `pg_get_constraintdef` renders the engine's own canonical form, action
       * clauses included, so the comparison is against what is actually there. */
      const expected = `FOREIGN KEY (${column}) REFERENCES ${wanted}`;
      const same =
        current && wanted &&
        this.normaliseConstraint(current.definition) === this.normaliseConstraint(expected);

      if (same) continue;

      if (current && !wanted && !this.removes) {
        this.keep(entityName, `foreign key ${current.name}`);
        continue;
      }

      if (current) {
        this.act("warn", 
          `[DB] Dropping foreign key ${current.name} on ${entityName}.${column} — ` +
            (wanted
              ? `the entity now points it at ${wanted}.`
              : `the entity no longer declares one.`),
        );
        await this.connection.query(this.dialect.dropForeignKey(entityName, current.name));
      }

      if (!wanted) continue;

      /* Postgres names an inline REFERENCES `<table>_<column>_fkey`, so using
         the same shape here means a constraint created at CREATE TABLE and one
         created by this loop are indistinguishable afterwards. */
      const name = `${entityName}_${column}_fkey`;

      try {
        await this.connection.query(this.dialect.addForeignKey(entityName, column, wanted, name));
      } catch (error) {
        /* Rows already there point at nothing. Same reasoning as an unsatisfied
           check: the schema has moved on, and what the constraint is for is
           everything written from now on. */
        if (!this.dialect.supportsUnvalidatedCheck) throw error;

        await this.connection.query(
          this.dialect.addForeignKey(entityName, column, wanted, name, false),
        );

        currentLogger().warn(
          `[DB] ${entityName}.${column} references ${wanted} NOT VALID: existing rows do not ` +
            `all resolve. New writes are checked; fix the orphans and run VALIDATE CONSTRAINT ` +
            `${name} to finish.`,
        );
      }
    }

    /* Column-level `unique: true` is a constraint. Reconciled here, after the
       effects — adding one is a tightening, and an effect is where duplicates
       get resolved first. Before 1.2.0 a change to `unique` on an existing
       column was not reconciled at all: declared, and not enforced. */
    const uniqueConstraints = this.dialect.listUniqueConstraints
      ? await this.dialect.listUniqueConstraints(this.connection, entityName)
      : null;

    if (uniqueConstraints && this.dialect.addUnique) {
      for (const [key, opt] of Object.entries(schema.columns) as [string, any][]) {
        if (opt.primaryKey) continue;
        const dbCol = String(opt.name);
        const existing = uniqueConstraints[dbCol];

        if (opt.unique === true && !existing) {
          await this.assertUnique(entityName, schema, [key], false);
          this.act("info", `[DB] Adding a unique constraint on ${entityName}.${dbCol}.`);
          await this.connection.query(this.dialect.addUnique(entityName, `${entityName}_${dbCol}_key`, dbCol));
        } else if (opt.unique !== true && existing && opt.unique !== "live" && !this.removes) {
          this.keep(entityName, `unique constraint ${existing}`);
        } else if (opt.unique !== true && existing) {
          this.act("warn", 
            `[DB] Dropping the unique constraint on ${entityName}.${dbCol} — the entity ` +
              `${opt.unique === "live" ? 'now declares it unique: "live"' : "no longer declares it unique"}.`,
          );
          await this.connection.query(this.dialect.dropForeignKey(entityName, existing));
        }
      }
    }

    const existingIndexes = await this.dialect.listIndexes(this.connection, entityName);
    const indexes = this.effectiveIndexes(entityName, schema);
    /* Postgres renders the predicate back as `WHERE (deleted_at IS NULL)`. */
    const flat = (text: string) => text.replace(/["\s()]/g, "").toLowerCase();

    for (const idx of indexes) {
      const create = this.indexStatement(entityName, schema, idx);
      const live = idx.unique === "live";

      if (!existingIndexes[idx.name]) {
        if (idx.unique) await this.assertUnique(entityName, schema, idx.columns, live);
        await this.connection.query(create);
        continue;
      }

      const currentDef = existingIndexes[idx.name];
      const mappedCols = idx.columns.map((c: string) => schema.columns[c]?.name || c);
      const colsMatch = mappedCols.every((c: string) => currentDef.includes(c));
      const uniqueMatch = idx.unique ? currentDef.includes("UNIQUE") : !currentDef.includes("UNIQUE");
      /* Compared both ways: an index that should be partial and is not, and
         one that is partial and should not be, are both a different index. */
      const predicateMatch = live
        ? flat(currentDef).endsWith(`where${flat(this.livePredicate(schema))}`)
        : !/\sWHERE\s/i.test(currentDef);

      if (!colsMatch || !uniqueMatch || !predicateMatch) {
        this.act("warn", `[DB] Recreating index ${idx.name} on ${entityName}.`);
        await this.connection.query(`DROP INDEX ${this.dialect.quote(idx.name)}`);
        if (idx.unique) await this.assertUnique(entityName, schema, idx.columns, live);
        await this.connection.query(create);
      }
    }

    /* Indexes the entity no longer declares. Only ones that exist in their own
       right: an index backing a primary key or a unique constraint belongs to
       that constraint and goes when it does. */
    const declaredIndexes = new Set(indexes.map((i: any) => i.name));

    for (const name of await this.dialect.listOwnedIndexes(this.connection, entityName)) {
      if (declaredIndexes.has(name)) continue;
      /* A `_live_key` index is sync's own rendering of `unique: "live"`; when
         the column stops being live-unique it is being replaced, not left
         behind, and goes whatever the mode. */
      if (!this.removes && !name.endsWith("_live_key")) {
        this.keep(entityName, `index ${name}`);
        continue;
      }

      this.act("warn", `[DB] Dropping index ${name} on ${entityName} — no longer declared.`);
      await this.connection.query(`DROP INDEX ${this.dialect.quote(name)}`);
    }

    const existingChecks = await this.dialect.listChecks(this.connection, entityName);

    /* Whether this engine can keep the declaration beside the constraint. It
       decides the whole strategy below, so it is read once. */
    const describe = this.dialect.describeCheck?.bind(this.dialect);

    for (const chk of schema.checks || []) {
      const existing = existingChecks[chk.name];

      if (!existing) {
        await this.addCheck(entityName, chk);
        if (describe) {
          await this.connection.query(describe(entityName, chk.name, chk.expression));
        }
        /* A widened stand-in from the loosen phase has done its job. */
        const wide = `${chk.name}_ecosy_wide`;
        if (existingChecks[wide]) {
          await this.connection.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${this.dialect.quote(wide)}`);
          delete existingChecks[wide];
        }
        continue;
      }

      /* Declared as before, but still NOT VALID — added over rows that broke
         it. Once they are fixed (by an effect, typically, which has just run)
         validating is all that is left, and nobody should have to remember to. */
      if (existing.validated === false && describe && existing.declared?.trim() === chk.expression.trim()) {
        await this.validateOrExplain(entityName, chk);
        continue;
      }

      /* Compared against what the entity DECLARED last time, never against what
       * the engine stored.
       *
       * The engine rewrites a check into its own canonical form: `IN (…)` comes
       * back as `= ANY (ARRAY[…])`, `BETWEEN` as two comparisons. The previous
       * version of this compared the declared expression's identifiers against
       * that rewritten text, so the words `IN` and `BETWEEN` were never found —
       * and every constraint written with either was dropped and recreated on
       * every single boot. A check using only `AND`, `OR` and `IS NULL`, which
       * the engine leaves alone, was the one kind that stayed quiet.
       *
       * There is no normalisation that fixes this, in either direction. So the
       * declaration is stored verbatim and compared as a string, and nothing is
       * normalised because nothing needs to be.
       */
      if (!describe) {
        /* No way to record a declaration, so no honest comparison exists.
           Leaving the constraint alone is the conservative half of the choice —
           recreating it on a guess is what this replaced. */
        continue;
      }

      const changed = existing.declared === null
        ? true   /* Created before declarations were recorded. Recreate once to
                    write one, and this branch never runs for it again. */
        : existing.declared.trim() !== chk.expression.trim();

      if (changed) {
        this.act("warn", 
          existing.declared === null
            ? `[DB] Recreating check constraint ${chk.name} on ${entityName} once, to record ` +
              `what it was declared from.`
            : `[DB] Recreating check constraint ${chk.name} on ${entityName} — the entity ` +
              `changed it.`,
        );

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

          await this.explainUnvalidated(entityName, { ...chk, name: chk.name });
        }

        await this.connection.query(
          `ALTER TABLE ${table} DROP CONSTRAINT ${this.dialect.quote(chk.name)}`,
        );
        await this.connection.query(
          `ALTER TABLE ${table} RENAME CONSTRAINT ${this.dialect.quote(staging)} ` +
            `TO ${this.dialect.quote(chk.name)}`,
        );

        await this.connection.query(describe(entityName, chk.name, chk.expression));
      }
    }

    /* Checks the entity no longer declares. */
    const declaredChecks = new Set((schema.checks || []).map((c: any) => c.name));

    for (const name of Object.keys(existingChecks)) {
      if (declaredChecks.has(name)) continue;
      /* `_ecosy_wide` is sync's own stand-in from the loosen phase; it goes
         whatever the mode. */
      if (!this.removes && !name.endsWith("_ecosy_wide")) {
        this.keep(entityName, `check ${name}`);
        continue;
      }

      if (!name.endsWith("_ecosy_wide")) {
        this.act("warn", `[DB] Dropping check ${name} on ${entityName} — no longer declared.`);
      }
      await this.connection.query(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${this.dialect.quote(name)}`,
      );
    }

    /* Last, so a sync that threw part way leaves the previous shape in place
       and the next run sees the same difference rather than a half-applied one. */
    this.warnHookBypass(entityName, schema, EntityClass);

    const kept = this.leftovers.get(entityName);
    if (kept?.length) {
      this.leftovers.delete(entityName);
      /* A column kept while another was added in the same sync is what a
         rename looks like without a snapshot: the new column arrives empty
         and the data stays behind in the old one. */
      const keptColumns = kept.some((k) => k.startsWith("column "));
      const renameHint = keptColumns && added.length
        ? ` If ${added.join(", ")} ${added.length === 1 ? "is" : "are"} a rename of a kept column, the data stayed ` +
          `in the old one: copy it across in an effect (the old column is still readable there), and turn on ` +
          `sync: { snapshot: true } so the next rename is recognised and moved.`
        : "";
      currentLogger().warn(
        `[DB] ${entityName}: ${this.sync.dryRun ? "would keep" : "kept"} ${kept.length} thing${kept.length === 1 ? "" : "s"} ` +
          `the entity no longer declares — ${kept.join(", ")}. Sync is additive and removes nothing. Drop ` +
          `${kept.length === 1 ? "it" : "them"} with a migration, or set sync: { mode: "mirror" } on the driver to let ` +
          `sync remove what the entity does not say.${renameHint}`,
      );
    }

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

/**
 * `'html'::text` against a declared `'html'`: the engine added a cast of the
 * column's own type to a quoted literal. Recognised without a round trip —
 * nearly every literal default renders this way, and the probe that settles
 * the other cases needs a temporary table.
 */
function sameLiteral(rendered: string, declared: string): boolean {
  const match = /^('(?:[^']|'')*')::[a-z][\w\s."]*$/i.exec(rendered);
  return Boolean(match) && match![1] === declared;
}

function safeMaxConnections(): number | undefined {
  try {
    return currentDriver().maxConnections;
  } catch {
    return undefined;
  }
}
