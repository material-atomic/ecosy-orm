/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import type { FindOptions, FindWhereOptions, ObjectWhere, SchemaOptions } from "./repository";
import type { Entity as BaseEntity } from "./entity";
import type { Dialect, Queryable } from "./drivers/types";
import { currentDialect } from "./drivers/current";


/**
 * Fills `{name}` placeholders in a SQL template.
 *
 * Local rather than imported. This was the only thing the package used from
 * `@ecosy/core`, and it used the plainest part of it: the templates below hold
 * five single-word placeholders and no dotted paths, arrays or nested objects,
 * which is what that function exists for. A dependency carried by everyone who
 * installs this, and a version to keep in step, for a `String.replace`.
 *
 * The replacement is a **function**, and that is not a style choice: the values
 * substituted here contain `$1`, `$2` — the parameter placeholders — and in a
 * replacement *string* those are capture-group references. `($1, $2)` would
 * come out as the matched text repeated, producing SQL that is syntactically
 * fine and asks for the wrong columns.
 *
 * A name with no value is left as it was written. Broken SQL that still shows
 * `{columns}` says which template failed; silently dropping it does not.
 */
function interpolate(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match,
  );
}

export class QueryBuilder<Entity extends BaseEntity> {
  private _sqls = {
    select: "SELECT {columns} FROM {entity}",
    insert: "INSERT INTO {entity} ({columns}) VALUES {values}",
    update: "UPDATE {entity} SET {assignments}",
    delete: "DELETE FROM {entity}",
    count: "SELECT COUNT(1) as count FROM {entity}",
  };

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

    const selectSql = interpolate(this._sqls.select, {
      columns: this.getQueryColumns(),
      entity: this.entityName,
    });

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
    
    const sql = interpolate(this._sqls.insert, {
      entity: this.entityName,
      columns: tsKeys.map(c => this.q(this.dbCol(c))).join(", "),
      values
    }) + this.returning();

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
      interpolate(this._sqls.update, {
        entity: this.entityName,
        assignments
      }),
      condition ? `WHERE ${condition}` : ""
    ].filter(Boolean).join(" ");

    return { sql, params };
  }

  buildDelete(where: FindWhereOptions<Entity>): { sql: string, params: any[] } {
    const params: any[] = [];
    const condition = this.buildWhereSql(where, params);
    
    const sql = [
      interpolate(this._sqls.delete, {
        entity: this.entityName
      }),
      condition ? `WHERE ${condition}` : ""
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
    
    const insertSql = interpolate(this._sqls.insert, {
      entity: this.entityName,
      columns: tsKeys.map(c => this.q(this.dbCol(c))).join(", "),
      values
    });

    const dbConflictColumns = conflictColumns.map(c => this.dbCol(c));

    const updateColumns = tsKeys
      .filter(c => !conflictColumns.includes(c))
      .map(c => this.dbCol(c));

    const sql = `${insertSql} ${this.dialect.upsertClause(dbConflictColumns, updateColumns)}${this.returning()}`;
    
    return { sql, params };
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

  private checkStatement(entityName: string, chk: any) {
    return `ALTER TABLE ${this.dialect.quote(entityName)} ADD CONSTRAINT ${this.dialect.quote(chk.name)} CHECK (${chk.expression})`;
  }

  async syncSchema(entityName: string, schema: SchemaOptions) {
    const table = this.dialect.quote(entityName);

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

      return;
    }

    const existingCols = Object.fromEntries(
      (await this.dialect.listColumns(this.connection, entityName)).map((c) => [c.name, c]),
    );

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
        console.log(`[DB] Recreating index ${idx.name} on ${entityName} due to changes...`);
        await this.connection.query(`DROP INDEX ${this.dialect.quote(idx.name)}`);
        await this.connection.query(create);
      }
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
        console.log(`[DB] Recreating check constraint ${chk.name} on ${entityName} due to changes...`);
        await this.connection.query(
          `ALTER TABLE ${table} DROP CONSTRAINT ${this.dialect.quote(chk.name)}`,
        );
        await this.connection.query(this.checkStatement(entityName, chk));
      }
    }
  }
}
