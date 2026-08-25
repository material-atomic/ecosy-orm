/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Entity as BaseEntity } from "./entity";
import { DataSource } from "./data-source";
import { QueryBuilder, SchemaBuilder } from "./query-builder";

export type FindCondition<T> =
  | T
  | ReturnType<typeof Not<T>>
  | ReturnType<typeof Like>
  | ReturnType<typeof Between<T>>;

export type ObjectWhere<Entity extends BaseEntity> = {
  [K in keyof Entity]?: FindCondition<Entity[K]>;
};

export interface AndCondition<Entity extends BaseEntity> {
  type: "AND";
  conditions: FindWhereOptions<Entity>[];
}

export interface OrCondition<Entity extends BaseEntity> {
  type: "OR";
  conditions: FindWhereOptions<Entity>[];
}

export type FindWhereOptions<Entity extends BaseEntity> =
  | ObjectWhere<Entity>
  | AndCondition<Entity>
  | OrCondition<Entity>
  | FindWhereOptions<Entity>[];

export interface FindOptions<Entity extends BaseEntity> {
  where?: FindWhereOptions<Entity>;
  limit?: number;
  offset?: number;
}

export function And<Entity extends BaseEntity>(...conditions: FindWhereOptions<Entity>[]): AndCondition<Entity> {
  return {
    type: "AND",
    conditions,
  };
}
export function Or<Entity extends BaseEntity>(...conditions: FindWhereOptions<Entity>[]): OrCondition<Entity> {
  return {
    type: "OR",
    conditions,
  };
}
export function Not<T>(value: T) {
  return {
    type: "NOT",
    value,
  } as const;
}
export function Like(value: string) {
  return {
    type: "LIKE",
    value,
  } as const;
}
export function Between<T>(value: [T, T]) {
  return {
    type: "BETWEEN",
    value,
  } as const;
}

export interface ColumnOptions {
  type: string;
  name?: string;
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  default?: string;
  references?: string;
  private?: boolean;
}

export interface IndexOptions {
  name: string;
  columns: readonly string[];
  unique?: boolean;
}

export interface SchemaOptions {
  columns: Record<string, ColumnOptions>;
  indexes?: readonly IndexOptions[];
}

export abstract class Repository<Entity extends BaseEntity> {
  public entityName: string;
  public schema: SchemaOptions;
  protected entityClass: new () => Entity;
  protected queryBuilder: QueryBuilder<Entity>;
  protected schemaBuilder: SchemaBuilder;
  protected connection: DataSource;

  constructor(
    entityFactory: { new (): Entity, entityName: string, schema: SchemaOptions }
  ) {
    this.connection = new DataSource();
    this.entityClass = entityFactory;
    this.entityName = entityFactory.entityName;
    this.schema = entityFactory.schema;
    this.queryBuilder = new QueryBuilder<Entity>(this.entityName, this.schema);
    this.schemaBuilder = new SchemaBuilder(this.connection);
  }

  getPrimaryKeyField(): string {
    const entry = Object.entries(this.schema.columns).find(([, v]) => v.primaryKey);
    return entry ? entry[0] : "id";
  }

  protected hydrateRows(rows: any[]): Entity[] {
    return rows.map(row => (this.entityClass as any).hydrate(row, this));
  }

  async syncSchema() {
    await this.schemaBuilder.syncSchema(this.entityName, this.schema);
  }

  async find(options: FindOptions<Entity>): Promise<Entity[]> {
    const { sql, params } = this.queryBuilder.buildSelect(options);
    const result = await this.connection.query(sql, params);
    return this.hydrateRows(result.rows);
  }

  async findOne(options: FindOptions<Entity>): Promise<Entity | null> {
    const { sql, params } = this.queryBuilder.buildSelect({ ...options, limit: 1 });
    const result = await this.connection.query(sql, params);
    return result.rows.length ? this.hydrateRows(result.rows)[0] : null;
  }

  async insert(data: Partial<Entity>): Promise<Entity>;
  async insert(data: Partial<Entity>[]): Promise<Entity[]>;
  async insert(data: Partial<Entity> | Partial<Entity>[]): Promise<Entity | Entity[] | null> {
    const isArray = Array.isArray(data);
    const arr = isArray ? data : [data];
    if (!arr.length) return isArray ? [] : null;
    
    const { sql, params } = this.queryBuilder.buildInsert(arr);
    const result = await this.connection.query(sql, params);

    return isArray ? this.hydrateRows(result.rows) : this.hydrateRows(result.rows)[0];
  }

  update(where: FindWhereOptions<Entity>, data: Partial<Entity>) {
    const { sql, params } = this.queryBuilder.buildUpdate(where, data);
    return this.connection.query(sql, params);
  }

  delete(where: FindWhereOptions<Entity>) {
    const { sql, params } = this.queryBuilder.buildDelete(where);
    return this.connection.query(sql, params);
  }

  async upsert(data: Partial<Entity>, conflictColumns: string[]): Promise<Entity>;
  async upsert(data: Partial<Entity>[], conflictColumns: string[]): Promise<Entity[]>;
  async upsert(data: Partial<Entity> | Partial<Entity>[], conflictColumns: string[]): Promise<Entity | Entity[] | null> {
    const isArray = Array.isArray(data);
    const arr = isArray ? data : [data];
    if (!arr.length) return isArray ? [] : null;
    
    const { sql, params } = this.queryBuilder.buildUpsert(arr, conflictColumns);
    const result = await this.connection.query(sql, params);
    
    return isArray ? this.hydrateRows(result.rows) : this.hydrateRows(result.rows)[0];
  }
}
