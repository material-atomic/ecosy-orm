/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PartialInput } from "./optional";
import type { Entity as BaseEntity, EntityConstructor } from "./entity";
import { DataSource } from "./data-source";
import type { Queryable } from "./drivers/types";
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

export type OrderDirection = "ASC" | "DESC";

export interface FindOptions<Entity extends BaseEntity> {
  /* Each says `| undefined` so a caller under `exactOptionalPropertyTypes`
     can pass a value it computed as maybe-absent — see ./optional. */
  where?: FindWhereOptions<Entity> | undefined;
  /**
   * Column to direction, applied in the order the keys are written.
   *
   * Reach for it whenever `limit` is set: SQL does not promise which rows a
   * limit returns without one, and Postgres is free to answer differently on
   * the next call for the same query.
   *
   * `PartialInput` rather than `Partial` — the direction may itself be a value
   * the caller computed and it may be absent. See ./optional.
   */
  order?: PartialInput<Record<Extract<keyof Entity, string>, OrderDirection>> | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Groups conditions that must all hold.
 *
 * `NoInfer` on the arguments is what makes this callable. Without it TypeScript
 * tries to infer `Entity` from the conditions themselves, and cannot: a literal
 * like `{ name: "a" }` does not satisfy `extends BaseEntity` — an entity also
 * carries `save`, `delete` and `_repository` — so inference falls back to the
 * constraint and every column then reads as an excess property:
 *
 * ```
 * TS2353: Object literal may only specify known properties,
 *         and 'name' does not exist in type 'FindWhereOptions<Entity>'
 * ```
 *
 * Blocking that leaves one source of inference: the position the result is
 * used in. Inside `find({ where: … })` that is `FindWhereOptions<User>`, so
 * `Entity` comes out as `User` and the conditions are then checked against it
 * — unknown columns and wrong value types are still errors.
 *
 * The trade is that a call with no contextual type has nothing to infer from
 * and falls back to the constraint again. Annotate the variable when that
 * happens, or write the call where it is used:
 *
 * ```ts
 * const active: FindWhereOptions<User> = And({ status: "active" });
 * ```
 */
/**
 * A repository for an entity that has no class of its own.
 *
 * Lives here rather than on `DataSource` as it used to. `DataSource` needed
 * `Repository` as a value only for this, while `Repository` needs
 * `DataSource` for every query it runs — so the one method made the two
 * modules import each other, and a cycle in a package whose entry re-exports
 * both is a class that is `undefined` at the moment the other is evaluated.
 * One direction remains: repository → data-source.
 */
export function createRepository<Entity extends BaseEntity>(
  EntityClass: EntityConstructor<Entity>,
): Repository<Entity> {
  class DynamicRepository extends Repository<Entity> {}

  return new DynamicRepository(EntityClass);
}

export function And<Entity extends BaseEntity>(
  ...conditions: NoInfer<FindWhereOptions<Entity>>[]
): AndCondition<Entity> {
  return {
    type: "AND",
    conditions,
  };
}

/** Groups conditions where any may hold. Infers as {@link And} does. */
export function Or<Entity extends BaseEntity>(
  ...conditions: NoInfer<FindWhereOptions<Entity>>[]
): OrCondition<Entity> {
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
  name?: string | undefined;
  primaryKey?: boolean | undefined;
  notNull?: boolean | undefined;
  unique?: boolean | undefined;
  default?: string | undefined;
  references?: string | undefined;
  private?: boolean | undefined;
}

export interface IndexOptions {
  name: string;
  columns: readonly string[];
  unique?: boolean | undefined;
}

export interface CheckOptions {
  name: string;
  expression: string;
}

export interface SchemaOptions {
  columns: Record<string, ColumnOptions>;
  indexes?: readonly IndexOptions[] | undefined;
  /**
   * Declared here or not at all.
   *
   * Sync drops every check on the table it does not find declared — including
   * ones it never created. A constraint added by hand in psql survives exactly
   * until the next boot, which is long enough to look like it worked.
   *
   * That is the same rule columns and indexes follow: the entity is the schema,
   * and anything the entity does not say is something the table should not
   * have. It is worth stating on this field because a CHECK is the one people
   * reach for a migration tool to add.
   */
  checks?: readonly CheckOptions[] | undefined;
}

export abstract class Repository<Entity extends BaseEntity> {
  public entityName: string;
  public schema: SchemaOptions;
  protected entityClass: new () => Entity;
  protected queryBuilder: QueryBuilder<Entity>;
  protected schemaBuilder: SchemaBuilder;
  /* Typed as Queryable, not DataSource: `using()` swaps in a Transaction, and
     everything here needs only `query`. */
  protected connection: Queryable;

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

  /**
   * The same repository, bound to a transaction.
   *
   * Returns a view rather than mutating: the original keeps running on the
   * pool, so a repository shared across requests cannot be dragged into one
   * request's transaction.
   *
   * @example
   * await DataSource.transaction(async (tx) => {
   *   await files.using(tx).delete({ projectId });
   *   await projects.using(tx).delete({ id: projectId });
   * });
   *
   * @param tx The transaction to run on.
   * @returns A repository of the same type whose statements go to `tx`.
   */
  using(tx: Queryable): this {
    /* The receiver becomes the prototype, so subclass methods and every other
       field are inherited and only `connection` is shadowed. */
    const bound = Object.create(this) as this;
    (bound as unknown as { connection: Queryable }).connection = tx;
    return bound;
  }

  getPrimaryKeyField(): string {
    const entry = Object.entries(this.schema.columns).find(([, v]) => v.primaryKey);
    return entry ? entry[0] : "id";
  }

  protected hydrateRows(rows: any[]): Entity[] {
    return rows.map(row => (this.entityClass as any).hydrate(row, this));
  }

  /**
   * Runs `beforeInsert` or `beforeUpdate` over each row, if the entity
   * declares it, and returns what the hook left behind.
   *
   * The hook gets a real instance as `this` — the same class `find` returns —
   * so it reads and assigns fields as it would anywhere else. What comes back
   * is the instance's own fields, which the builder then filters to declared
   * columns; nothing a hook adds that is not a column reaches the SQL.
   *
   * Entities without the hook skip all of this, and pay nothing for it.
   */
  protected async prepare(
    rows: PartialInput<Entity>[],
    hook: "beforeInsert" | "beforeUpdate",
  ): Promise<PartialInput<Entity>[]> {
    if (typeof (this.entityClass.prototype as any)[hook] !== "function") return rows;

    const prepared: PartialInput<Entity>[] = [];
    for (const row of rows) {
      const instance = new this.entityClass();
      Object.assign(instance, row);
      await (instance as any)[hook]();
      prepared.push({ ...(instance as any) });
    }
    return prepared;
  }

  /**
   * Brings this entity's table in line with its schema, running the entity's
   * effects at the point sync leaves room for them. See {@link EntityEffect}.
   */
  async syncSchema() {
    await this.schemaBuilder.syncSchema(this.entityName, this.schema, this.entityClass);
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

  async insert(data: PartialInput<Entity>): Promise<Entity>;
  async insert(data: PartialInput<Entity>[]): Promise<Entity[]>;
  async insert(data: PartialInput<Entity> | PartialInput<Entity>[]): Promise<Entity | Entity[] | null> {
    const isArray = Array.isArray(data);
    const arr = await this.prepare(isArray ? data : [data], "beforeInsert");
    if (!arr.length) return isArray ? [] : null;
    
    const { sql, params } = this.queryBuilder.buildInsert(arr);
    const result = await this.connection.query(sql, params);

    return isArray ? this.hydrateRows(result.rows) : this.hydrateRows(result.rows)[0];
  }

  /**
   * Updates every row matching `where`.
   *
   * A field set to `undefined` is not written — the column keeps what it had.
   * A patch with nothing left to write (after `beforeUpdate`) runs no statement
   * and reports no rows, rather than sending `SET` with nothing after it.
   */
  async update(where: FindWhereOptions<Entity>, data: PartialInput<Entity>) {
    const [patch] = await this.prepare([data], "beforeUpdate");
    const { sql, params } = this.queryBuilder.buildUpdate(where, patch!);
    if (!sql) return { rows: [], rowCount: 0 };
    return this.connection.query(sql, params);
  }

  delete(where: FindWhereOptions<Entity>) {
    const { sql, params } = this.queryBuilder.buildDelete(where);
    return this.connection.query(sql, params);
  }

  async upsert(data: PartialInput<Entity>, conflictColumns: string[]): Promise<Entity>;
  async upsert(data: PartialInput<Entity>[], conflictColumns: string[]): Promise<Entity[]>;
  async upsert(data: PartialInput<Entity> | PartialInput<Entity>[], conflictColumns: string[]): Promise<Entity | Entity[] | null> {
    const isArray = Array.isArray(data);
    const arr = await this.prepare(isArray ? data : [data], "beforeInsert");
    if (!arr.length) return isArray ? [] : null;
    
    const { sql, params } = this.queryBuilder.buildUpsert(arr, conflictColumns);
    const result = await this.connection.query(sql, params);
    
    return isArray ? this.hydrateRows(result.rows) : this.hydrateRows(result.rows)[0];
  }
}
