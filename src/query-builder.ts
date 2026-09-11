/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import { currentLogger } from "./logger";
import type { FindOptions, FindWhereOptions, ObjectWhere, SchemaOptions } from "./repository";
import type { Entity as BaseEntity } from "./entity";
import type { ColumnInfo, Dialect, Queryable, SyncOptions } from "./drivers/types";
import { currentDialect, currentDriver } from "./drivers/current";
import { DataSource } from "./data-source";


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
    const condition = this.buildWhereSql(where, params);
    
    const sql = [
      `UPDATE ${this.entityName} SET ${assignments}`,
      condition ? `WHERE ${condition}` : "",
    ].filter(Boolean).join(" ") + (returning ? this.returning() : "");

    return { sql, params };
  }

  buildDelete(where: FindWhereOptions<Entity>, returning = false): { sql: string, params: any[] } {
    const params: any[] = [];
    const condition = this.buildWhereSql(where, params);
    
    const sql = [
      `DELETE FROM ${this.entityName}`,
      condition ? `WHERE ${condition}` : "",
    ].filter(Boolean).join(" ") + (returning ? this.returning() : "");

    return { sql, params };
  }

  buildUpsert(arr: PartialInput<Entity>[], conflictColumns: string[]): { sql: string, params: any[] } {
    if (!arr.length) return { sql: "", params: [] };
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

  private columnDefinition(opt: any, withPrimaryKey: boolean, withNotNull = true) {
    let def = `${this.dialect.quote(opt.name)} ${opt.type}`;
    if (withPrimaryKey && opt.primaryKey) def += " PRIMARY KEY";
    if (opt.unique) def += " UNIQUE";
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
        currentLogger().warn(`[DB] Dropping the default of ${entityName}.${dbCol} — the entity no longer declares one.`);
        await this.connection.query(this.dialect.alterDefault(entityName, dbCol, null));
        continue;
      }

      if (current === null) toSet.push({ dbCol, expression: declared });
      else if (current !== declared) toCompare.push({ dbCol, opt, current, declared });
    }

    if (toCompare.length && this.dialect.renderDefaults) {
      const render = this.dialect.renderDefaults.bind(this.dialect);
      const rendered = await DataSource.transaction((tx) =>
        render(tx, toCompare.map((c) => ({ type: String(c.opt.type), expression: c.declared }))),
      );
      toCompare.forEach((c, i) => {
        if (rendered[i] !== c.current) toSet.push({ dbCol: c.dbCol, expression: c.declared });
      });
    }

    for (const { dbCol, expression } of toSet) {
      currentLogger().info(`[DB] Setting the default of ${entityName}.${dbCol} to ${expression}.`);
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
        if (error?.code !== "23505" || attempt >= attempts) {
          if (error?.code === "23505") {
            throw new Error(
              `[DB] Filling ${entityName}.${dbCol} from its default collided with an existing ` +
                `value ${attempts} times running. Its default cannot produce enough distinct ` +
                `values for a unique column — widen it, or fill these rows from an effect.`,
              { cause: error },
            );
          }
          throw error;
        }
        currentLogger().warn(`[DB] ${entityName}.${dbCol}: default collided on a unique value, retrying (${attempt}/${attempts}).`);
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
      if (!ref) continue;

      if (removeHooks.length && /ON\s+DELETE\s+CASCADE/i.test(ref)) {
        currentLogger().warn(
          `[DB] ${entityName} declares ${removeHooks.join(" and ")}, but ${entityName}.${opt.name} ` +
            `references ${ref}: rows removed by that cascade are deleted by the database, and no ` +
            `hook sees them.`,
        );
      }
      if (updateHooks.length && /ON\s+(DELETE\s+SET\s+(NULL|DEFAULT)|UPDATE\s+(CASCADE|SET\s+(NULL|DEFAULT)))/i.test(ref)) {
        currentLogger().warn(
          `[DB] ${entityName} declares ${updateHooks.join(" and ")}, but ${entityName}.${opt.name} ` +
            `references ${ref}: rows that action changes are changed by the database, and no ` +
            `hook sees them.`,
        );
      }
    }
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
    const table = this.dialect.quote(entityName);
    const runEffects = async () => {
      if (!(EntityClass as { effects?: unknown[] } | undefined)?.effects?.length) return;
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

      for (const idx of schema.indexes || []) {
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
      currentLogger().warn(`[DB] Renaming ${entityName}.${from} → ${to}`);
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
        currentLogger().warn(
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

    await runEffects();

    for (const { dbCol, opt } of tighten) {
      /* Counted first so the failure names what to do. Left to the engine it
         reads "column contains null values" and stops the boot — the error
         sniprender met when `projects.code` became required over rows that
         predated it. */
      const countNulls = async () => Number((await this.connection.query(
        `SELECT count(*) AS n FROM ${table} WHERE ${this.dialect.quote(dbCol)} IS NULL`,
      )).rows[0]?.n ?? 0);

      let n = await countNulls();

      /* A declared default fills them, the way ADD COLUMN fills existing rows
         with one: the entity said what an absent value is, and a NULL row is
         a row with an absent value. */
      if (n > 0 && opt.default) {
        currentLogger().warn(
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
          `[DB] ${entityName}.${name} is being dropped while ${added.join(", ")} ` +
            `${added.length === 1 ? "was" : "were"} added. If that is a rename, the data is ` +
            `about to be lost — sync cannot tell a rename from a drop-and-add without ` +
            `\`sync: { snapshot: true }\` on the driver, which is off by default.`,
        );
      }

      currentLogger().warn(`[DB] Dropping ${entityName}.${name} — the entity no longer declares it.`);
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

      if (current) {
        currentLogger().warn(
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

    /* Whether this engine can keep the declaration beside the constraint. It
       decides the whole strategy below, so it is read once. */
    const describe = this.dialect.describeCheck?.bind(this.dialect);

    for (const chk of schema.checks || []) {
      const existing = existingChecks[chk.name];

      if (!existing) {
        await this.connection.query(this.checkStatement(entityName, chk));
        if (describe) {
          await this.connection.query(describe(entityName, chk.name, chk.expression));
        }
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
        currentLogger().warn(
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

        await this.connection.query(describe(entityName, chk.name, chk.expression));
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
    this.warnHookBypass(entityName, schema, EntityClass);

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
