/* eslint-disable @typescript-eslint/no-explicit-any */
import { Serialize } from "@ecosy/core/serialize";
import type { FindOptions, FindWhereOptions, ObjectWhere, SchemaOptions } from "./repository";
import type { Entity as BaseEntity } from "./entity";

export class QueryBuilder<Entity extends BaseEntity> {
  private _sqls = {
    select: "SELECT {columns} FROM {entity}",
    insert: "INSERT INTO {entity} ({columns}) VALUES {values}",
    update: "UPDATE {entity} SET {assignments}",
    delete: "DELETE FROM {entity}",
    count: "SELECT COUNT(1) as count FROM {entity}",
  };

  constructor(public entityName: string, public schema: SchemaOptions) {}

  private dbCol(tsKey: string): string {
    return this.schema.columns[tsKey]?.name || tsKey;
  }

  private withEntity(tsKey: string) {
    return `"${this.entityName}"."${this.dbCol(tsKey)}"`;
  }

  /** Keys the entity actually declares. A typo never reaches SQL as a column name. */
  private known(tsKeys: string[]): string[] {
    return tsKeys.filter((k) => k in this.schema.columns);
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

  private getQueryColumns() {
    return Object.keys(this.schema.columns).map((tsKey) => {
      return `"${this.entityName}"."${this.dbCol(tsKey)}" AS "${tsKey}"`;
    }).join(", ");
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

      /* `x = NULL` is UNKNOWN in SQL and never true, so a null here has to become
         IS NULL. It used to compile to `= $1` with a null parameter: no error,
         no rows, and the same silence from update and delete, which share this
         method. `{ deletedAt: null }` type-checks on any nullable column, so the
         type system was actively inviting it. */
      if (value === null) return `${this.withEntity(tsKey)} IS NULL`;

      if (typeof value === "object" && "type" in value) {
        const v = value as any;
        if (v.type === "NOT") {
          if (v.value === null) return `${this.withEntity(tsKey)} IS NOT NULL`;
          params.push(v.value);
          return `${this.withEntity(tsKey)} != $${params.length}`;
        }
        if (v.type === "LIKE") {
          params.push(v.value);
          return `${this.withEntity(tsKey)} LIKE $${params.length}`;
        }
        if (v.type === "BETWEEN") {
          params.push(v.value[0], v.value[1]);
          return `${this.withEntity(tsKey)} BETWEEN $${params.length - 1} AND $${params.length}`;
        }
      }
      params.push(this.encode(tsKey, value));
      return `${this.withEntity(tsKey)} = $${params.length}`;
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
    /* LIMIT without an order is not deterministic: Postgres may return any N
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

    const selectSql = Serialize.interpolate(this._sqls.select, {
      columns: this.getQueryColumns(),
      entity: this.entityName,
    });

    const sql = [selectSql, result.join(" ")].filter(Boolean).join(" ");
    return { sql, params };
  }

  buildInsert(arr: Partial<Entity>[]): { sql: string, params: any[] } {
    if (!arr.length) return { sql: "", params: [] };
    /* The UNION of every row's keys, not the first row's. Taking row 0 dropped a
       field that only later rows carried, and turned a field missing from a
       later row into NULL — which surfaced as a not-null violation naming the
       column rather than the real cause, a row whose shape differed. */
    const tsKeys = this.known([...new Set(arr.flatMap((o) => Object.keys(o)))]);
    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        params.push(this.encode(c, (obj as any)[c]));
        return `$${params.length}`;
      }).join(", ")})`;
    }).join(", ");
    
    const sql = Serialize.interpolate(this._sqls.insert, {
      entity: this.entityName,
      columns: tsKeys.map(c => `"${this.dbCol(c)}"`).join(", "),
      values
    }) + ` RETURNING ${this.getQueryColumns()}`;

    return { sql, params };
  }

  buildUpdate(where: FindWhereOptions<Entity>, data: Partial<Entity>): { sql: string, params: any[] } {
    const params: any[] = [];
    const assignments = Object.entries(data)
      .filter(([tsKey]) => tsKey in this.schema.columns)
      .map(([tsKey, v]) => {
        params.push(this.encode(tsKey, v));
        return `"${this.dbCol(tsKey)}" = $${params.length}`;
      }).join(", ");
    const condition = this.buildWhereSql(where, params);
    
    const sql = [
      Serialize.interpolate(this._sqls.update, {
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
      Serialize.interpolate(this._sqls.delete, {
        entity: this.entityName
      }),
      condition ? `WHERE ${condition}` : ""
    ].filter(Boolean).join(" ");

    return { sql, params };
  }

  buildUpsert(arr: Partial<Entity>[], conflictColumns: string[]): { sql: string, params: any[] } {
    if (!arr.length) return { sql: "", params: [] };
    /* The UNION of every row's keys, not the first row's. Taking row 0 dropped a
       field that only later rows carried, and turned a field missing from a
       later row into NULL — which surfaced as a not-null violation naming the
       column rather than the real cause, a row whose shape differed. */
    const tsKeys = this.known([...new Set(arr.flatMap((o) => Object.keys(o)))]);
    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        params.push(this.encode(c, (obj as any)[c]));
        return `$${params.length}`;
      }).join(", ")})`;
    }).join(", ");
    
    const insertSql = Serialize.interpolate(this._sqls.insert, {
      entity: this.entityName,
      columns: tsKeys.map(c => `"${this.dbCol(c)}"`).join(", "),
      values
    });

    const dbConflictColumns = conflictColumns.map(c => this.dbCol(c));

    const assignments = tsKeys
      .filter(c => !conflictColumns.includes(c))
      .map(c => `"${this.dbCol(c)}" = EXCLUDED."${this.dbCol(c)}"`)
      .join(", ");

    const sql = `${insertSql} ON CONFLICT (${dbConflictColumns.map(c => `"${c}"`).join(", ")}) DO UPDATE SET ${assignments} RETURNING ${this.getQueryColumns()}`;
    
    return { sql, params };
  }
}

export class SchemaBuilder {
  constructor(private connection: any) {}

  async syncSchema(entityName: string, schema: SchemaOptions) {
    const tableCheck = await this.connection.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = $1
          AND table_schema = ANY(current_schemas(false))
      )
    `, [entityName]);
    const tableExists = tableCheck.rows[0].exists;

    if (!tableExists) {
      const columnsSql = Object.entries(schema.columns).map(([, opt]) => {
        let def = `"${opt.name}" ${opt.type}`;
        if (opt.primaryKey) def += " PRIMARY KEY";
        if (opt.unique) def += " UNIQUE";
        if (opt.notNull) def += " NOT NULL";
        if (opt.default) def += ` DEFAULT ${opt.default}`;
        if (opt.references) def += ` REFERENCES ${opt.references}`;
        return def;
      }).join(",\n  ");

      await this.connection.query(`CREATE TABLE "${entityName}" (\n  ${columnsSql}\n)`);
      
      for (const idx of (schema.indexes || [])) {
        const unique = idx.unique ? "UNIQUE " : "";
        const cols = idx.columns.map(c => `"${schema.columns[c]?.name || c}"`).join(", ");
        await this.connection.query(`CREATE ${unique}INDEX "${idx.name}" ON "${entityName}" (${cols})`);
      }
      
      for (const chk of (schema.checks || [])) {
        await this.connection.query(`ALTER TABLE "${entityName}" ADD CONSTRAINT "${chk.name}" CHECK (${chk.expression})`);
      }
      return;
    }

    const columnsQuery = await this.connection.query(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = $1
        AND table_schema = ANY(current_schemas(false))
    `, [entityName]);
    const existingCols = columnsQuery.rows.reduce((acc: any, row: any) => {
      acc[row.column_name] = row;
      return acc;
    }, {});

    for (const [, opt] of Object.entries(schema.columns)) {
      const dbCol = opt.name as string;
      if (!existingCols[dbCol]) {
        let def = `"${dbCol}" ${opt.type}`;
        if (opt.unique) def += " UNIQUE";
        if (opt.notNull) def += " NOT NULL";
        if (opt.default) def += ` DEFAULT ${opt.default}`;
        if (opt.references) def += ` REFERENCES ${opt.references}`;
        await this.connection.query(`ALTER TABLE "${entityName}" ADD COLUMN ${def}`);
      } else {
        const isNotNull = existingCols[dbCol].is_nullable === 'NO';
        if (opt.notNull && !isNotNull && !opt.primaryKey) {
          await this.connection.query(`ALTER TABLE "${entityName}" ALTER COLUMN "${dbCol}" SET NOT NULL`);
        } else if (!opt.notNull && isNotNull && !opt.primaryKey) {
          await this.connection.query(`ALTER TABLE "${entityName}" ALTER COLUMN "${dbCol}" DROP NOT NULL`);
        }
      }
    }

    const indexQuery = await this.connection.query(`
      SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1
    `, [entityName]);
    const existingIndexes = indexQuery.rows.reduce((acc: any, row: any) => {
      acc[row.indexname] = row.indexdef;
      return acc;
    }, {});

    for (const idx of (schema.indexes || [])) {
      const unique = idx.unique ? "UNIQUE " : "";
      const cols = idx.columns.map(c => `"${schema.columns[c]?.name || c}"`).join(", ");
      
      if (!existingIndexes[idx.name]) {
        await this.connection.query(`CREATE ${unique}INDEX "${idx.name}" ON "${entityName}" (${cols})`);
      } else {
        const currentDef: string = existingIndexes[idx.name];
        const mappedCols = idx.columns.map(c => schema.columns[c]?.name || c);
        const colsMatch = mappedCols.every(c => currentDef.includes(c));
        const uniqueMatch = idx.unique ? currentDef.includes("UNIQUE") : !currentDef.includes("UNIQUE");
        
        if (!colsMatch || !uniqueMatch) {
          console.log(`[DB] Recreating index ${idx.name} on ${entityName} due to changes...`);
          await this.connection.query(`DROP INDEX "${idx.name}"`);
          await this.connection.query(`CREATE ${unique}INDEX "${idx.name}" ON "${entityName}" (${cols})`);
        }
      }
    }

    const checkQuery = await this.connection.query(`
      SELECT conname, pg_get_constraintdef(oid) as condef
      FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'c'
    `, [entityName]);
    const existingChecks = checkQuery.rows.reduce((acc: any, row: any) => {
      acc[row.conname] = row.condef;
      return acc;
    }, {});

    for (const chk of (schema.checks || [])) {
      if (!existingChecks[chk.name]) {
        await this.connection.query(`ALTER TABLE "${entityName}" ADD CONSTRAINT "${chk.name}" CHECK (${chk.expression})`);
      } else {
        const currentDef: string = existingChecks[chk.name];
        // Postgres rewrites the expression, so we check if all words/identifiers in our expression appear in the db's expression
        const tokens = chk.expression.match(/[a-zA-Z0-9_]{2,}/g) || [];
        const match = tokens.every(t => currentDef.includes(t));
        
        if (!match) {
          console.log(`[DB] Recreating check constraint ${chk.name} on ${entityName} due to changes...`);
          await this.connection.query(`ALTER TABLE "${entityName}" DROP CONSTRAINT "${chk.name}"`);
          await this.connection.query(`ALTER TABLE "${entityName}" ADD CONSTRAINT "${chk.name}" CHECK (${chk.expression})`);
        }
      }
    }
  }
}
