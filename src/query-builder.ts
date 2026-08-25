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
      if (value !== null && typeof value === "object" && "type" in value) {
        const v = value as any;
        if (v.type === "NOT") {
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
      params.push(value);
      return `${this.withEntity(tsKey)} = $${params.length}`;
    });

    return conditions.length ? conditions.join(" AND ") : "";
  }

  buildSelect(options: FindOptions<Entity>): { sql: string, params: any[] } {
    const params: any[] = [];
    const result: string[] = [];
    const where = this.buildWhereSql(options.where ?? ({} as any), params);
    
    if (where) {
      result.push(`WHERE ${where}`);
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
    const tsKeys = Object.keys(arr[0]);
    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        params.push((obj as any)[c]);
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
    const assignments = Object.entries(data).map(([tsKey, v]) => {
      params.push(v);
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
    const tsKeys = Object.keys(arr[0]);
    const params: any[] = [];
    const values = arr.map(obj => {
      return `(${tsKeys.map(c => {
        params.push((obj as any)[c]);
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
      return;
    }

    const columnsQuery = await this.connection.query(`
      SELECT column_name, is_nullable 
      FROM information_schema.columns 
      WHERE table_name = $1
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
  }
}
